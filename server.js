const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');

const app = express();
// Railway (and most PaaS) inject the port to listen on via process.env.PORT.
const PORT = process.env.PORT || 3000;
// ── Middleware (must be before routes) ───────────────────────────────────────
app.use(compression());          // gzip everything (static files + JSON responses)
app.use(cors());
app.use(express.json({ limit: '50mb' }));  // base64 images from JO items can be large
app.use(express.static('public'));

// ── Storage paths ─────────────────────────────────────────────────────────────
// Locally this points at the Google Drive shared folder (Windows). On Railway,
// set DRIVE_FOLDER to a mounted volume path (e.g. /data/quotes) so generated PDFs
// and the quotes/serials JSON persist across deploys. Railway's default filesystem
// is EPHEMERAL — without a mounted volume, anything written here is wiped on every
// redeploy/restart.
const DRIVE_FOLDER = process.env.DRIVE_FOLDER
    || 'G:\\Shared drives\\JOBS (OPERATIONS)\\8_SALES\\1. GENERATED QUOTES';
const QUOTES_FILE   = path.join(DRIVE_FOLDER, 'lp_quotes.json');
const SERIALS_FILE  = path.join(DRIVE_FOLDER, 'lp_serials.json');

// Profiles stored separately so the admin panel works even before Drive is mounted.
// On Railway, set DATA_DIR to a mounted volume (e.g. /data) for persistence.
const LOCAL_DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PROFILES_FILE  = path.join(LOCAL_DATA_DIR, 'lp_profiles.json');
fs.mkdirSync(LOCAL_DATA_DIR, { recursive: true }); // ensure data dir exists

// ── Admin config ────────────────────────────────────────────────────────────
// Set ADMIN_PASSWORD in the environment for production (the repo is public — never
// rely on the hardcoded fallback in a deployed instance). Token is random per restart.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '11223';
const ADMIN_TOKEN    = require('crypto').randomBytes(24).toString('hex');

// ── Per-file mutex ────────────────────────────────────────────────────────────
// Two requests hitting the same JSON file at once (e.g. two reps saving a quote,
// or two serial increments) would otherwise race: both read the old contents,
// both write back, and one update silently disappears. This serializes every
// read/write against a given file so they run one-at-a-time, in order.
class Mutex {
    constructor() { this._queue = Promise.resolve(); }
    run(task) {
        const result = this._queue.then(task, task);
        this._queue = result.then(() => {}, () => {}); // keep the chain alive even on error
        return result;
    }
}
const fileMutexes = new Map();
function withFileLock(filePath, task) {
    if (!fileMutexes.has(filePath)) fileMutexes.set(filePath, new Mutex());
    return fileMutexes.get(filePath).run(task);
}

// ── File-based DB helpers (async — no longer block the event loop) ───────────
async function readJSON(filePath) {
    try {
        const content = await fsp.readFile(filePath, 'utf8');
        return JSON.parse(content);
    } catch (err) {
        if (err.code !== 'ENOENT') console.error(`[readJSON] ${filePath}:`, err.message);
        return {};
    }
}

async function writeJSON(filePath, data) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    // Write to a temp file then rename, so a crash or sync hiccup mid-write
    // can never leave lp_quotes.json / lp_serials.json half-written/corrupt.
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    await fsp.rename(tmpPath, filePath);
}

// ── QUOTES API ────────────────────────────────────────────────────────────────

// GET all quotes
app.get('/api/quotes', async (req, res) => {
    const db = await withFileLock(QUOTES_FILE, () => readJSON(QUOTES_FILE));
    res.json(db);
});

// POST save/update a quote
app.post('/api/quotes', async (req, res) => {
    try {
        const { storeKey, snapshot } = req.body;
        if (!storeKey || !snapshot) return res.status(400).json({ error: 'Missing storeKey or snapshot' });

        await withFileLock(QUOTES_FILE, async () => {
            const db = await readJSON(QUOTES_FILE);
            // Preserve original createdAt
            if (db[storeKey] && db[storeKey].createdAt) {
                snapshot.createdAt = db[storeKey].createdAt;
            }
            snapshot.lastSaved = new Date().toISOString();
            db[storeKey] = snapshot;
            await writeJSON(QUOTES_FILE, db);
        });

        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// DELETE a quote (and its PDF file if it exists)
app.delete('/api/quotes/:storeKey', async (req, res) => {
    try {
        const storeKey = decodeURIComponent(req.params.storeKey);
        let pdfPath = null;
        let snap    = null;
        await withFileLock(QUOTES_FILE, async () => {
            const db = await readJSON(QUOTES_FILE);
            snap    = db[storeKey] || null;
            pdfPath = snap?.pdfPath || null;
            delete db[storeKey];
            await writeJSON(QUOTES_FILE, db);
        });

        // If pdfPath was stored, use it directly; otherwise reconstruct from snapshot data
        const tryDelete = (p) => {
            try {
                if (p && fs.existsSync(p)) { fs.unlinkSync(p); console.log(`[PDF DELETE] Removed: ${p}`); }
            } catch (e) { console.warn(`[PDF DELETE] Could not delete: ${e.message}`); }
        };

        if (pdfPath) {
            tryDelete(pdfPath);
        } else if (snap) {
            // Reconstruct filename the same way the generate route does
            const ctrl      = snap.controlNumber || 'Q26_0000';
            const company   = (snap.company     || 'Quotation').replace(/[^a-z0-9_\- ]/gi, '_');
            const project   = (snap.projectName || '').replace(/[^a-z0-9_\- ]/gi, '_').trim();
            const revNum    = parseInt(snap.revisions) || 0;
            const revSuffix = revNum > 0 ? ` - Rev${revNum}` : '';
            const projPart  = project ? ` - ${project}` : '';
            const salesPart = (snap.salesName || '').replace(/[^a-z0-9_\- ]/gi, '_').trim();
            const salesStr  = salesPart ? ` - ${salesPart}` : '';
            const filename  = `${ctrl} ${company}${projPart}${revSuffix}${salesStr}.pdf`;
            const companyFolderName = (snap.company || 'Unknown')
                .replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '').trim() || 'Unknown';
            // Try company subfolder first, then root
            tryDelete(path.join(DRIVE_FOLDER, companyFolderName, filename));
            tryDelete(path.join(DRIVE_FOLDER, filename));
        }

        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── SERIALS API ───────────────────────────────────────────────────────────────

// GET all serials
app.get('/api/serials', async (req, res) => {
    const serials = await withFileLock(SERIALS_FILE, () => readJSON(SERIALS_FILE));
    res.json(serials);
});

// POST increment and return new serial for a company
app.post('/api/serials/next', async (req, res) => {
    try {
        const { companyKey } = req.body;
        if (!companyKey) return res.status(400).json({ error: 'Missing companyKey' });

        // Read-increment-write happens as one atomic unit under the lock, so two
        // reps committing a serial for the same company at the same moment can
        // never both walk away with the same number.
        const serial = await withFileLock(SERIALS_FILE, async () => {
            const serials = await readJSON(SERIALS_FILE);
            serials[companyKey] = (serials[companyKey] || 0) + 1;
            await writeJSON(SERIALS_FILE, serials);
            return serials[companyKey];
        });

        res.json({ serial });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET peek next serial for a company (without committing)
app.get('/api/serials/peek', async (req, res) => {
    try {
        const companyKey = (req.query.companyKey || '').trim().toLowerCase();
        const serials = await withFileLock(SERIALS_FILE, () => readJSON(SERIALS_FILE));
        res.json({ serial: (serials[companyKey] || 0) + 1 });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// PUT /api/serials/:companyKey  — set serial to a specific value (used after deletions)
app.put('/api/serials/:companyKey', async (req, res) => {
    try {
        const key   = decodeURIComponent(req.params.companyKey).trim().toLowerCase();
        const { value } = req.body;
        if (typeof value !== 'number' || value < 0) return res.status(400).json({ error: 'Invalid value' });
        await withFileLock(SERIALS_FILE, async () => {
            const serials = await readJSON(SERIALS_FILE);
            if (value === 0) {
                delete serials[key];
            } else {
                serials[key] = value;
            }
            await writeJSON(SERIALS_FILE, serials);
        });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// DELETE reset serial for a specific company key
app.delete('/api/serials/:companyKey', async (req, res) => {
    try {
        const key = decodeURIComponent(req.params.companyKey).trim().toLowerCase();
        await withFileLock(SERIALS_FILE, async () => {
            const serials = await readJSON(SERIALS_FILE);
            delete serials[key];
            await writeJSON(SERIALS_FILE, serials);
        });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── JOB ORDERS API ────────────────────────────────────────────────────────────

const JO_FILE = path.join(DRIVE_FOLDER, 'lp_joborders.json');

// GET all job orders
app.get('/api/joborders', async (req, res) => {
    const db = await withFileLock(JO_FILE, () => readJSON(JO_FILE));
    res.json(db);
});

// POST save/update a job order
app.post('/api/joborders', async (req, res) => {
    try {
        const { storeKey, snapshot } = req.body;
        if (!storeKey || !snapshot) return res.status(400).json({ error: 'Missing storeKey or snapshot' });

        await withFileLock(JO_FILE, async () => {
            const db = await readJSON(JO_FILE);
            if (db[storeKey] && db[storeKey].createdAt) snapshot.createdAt = db[storeKey].createdAt;
            snapshot.lastSaved = new Date().toISOString();
            db[storeKey] = snapshot;
            await writeJSON(JO_FILE, db);
        });

        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// DELETE a job order
app.delete('/api/joborders/:storeKey', async (req, res) => {
    try {
        const storeKey = decodeURIComponent(req.params.storeKey);
        let snap = null;
        await withFileLock(JO_FILE, async () => {
            const db = await readJSON(JO_FILE);
            snap = db[storeKey] || null;
            delete db[storeKey];
            await writeJSON(JO_FILE, db);
        });

        // Try deleting the associated PDF if it was saved
        if (snap?.pdfPath) {
            try { if (fs.existsSync(snap.pdfPath)) fs.unlinkSync(snap.pdfPath); } catch {}
        }

        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST generate job order PDF
app.post('/api/generate-joborder', async (req, res) => {
    let page = null;
    try {
        const data = req.body;

        if (!data.joNumber) return res.status(400).send('JO Number is required.');
        if (!data.client)   return res.status(400).send('Client name is required.');

        // Flatten all items from quote groups
        const allItems = [];
        (data.groups || []).forEach(group => {
            (group.items || []).forEach(item => {
                allItems.push({ ...item, projectName: group.projectName || '', ctrlNum: group.ctrlNum || '' });
            });
        });
        if (!allItems.length) return res.status(400).send('Add at least one item.');

        const logoBase64 = getLogoBase64();

        // Format date
        let displayDate = data.dateRaw || data.date || '';
        if (displayDate && displayDate.match(/^\d{4}-\d{2}-\d{2}$/)) {
            const [y, m, d] = displayDate.split('-');
            const months = ['January','February','March','April','May','June',
                            'July','August','September','October','November','December'];
            displayDate = `${months[parseInt(m)-1]} ${parseInt(d)}, ${y}`;
        }

        const html = generateJobOrderHTML({
            ...data,
            allItems,
            displayDate,
            time: data.timeRaw || data.time || '',
        }, logoBase64);

        const pdfBuffer = await renderPDF(html);

        const joNum    = data.joNumber || '0000';
        const client   = (data.client || 'Client').replace(/[^a-z0-9_\- ]/gi, '_');
        const filename = `JO26-${joNum} ${client}.pdf`;

        // Save PDF to Drive (skip for preview)
        if (!data.skipDriveSave) {
            try {
                const joFolder = path.join(DRIVE_FOLDER, 'JOB ORDERS');
                if (!fs.existsSync(joFolder)) fs.mkdirSync(joFolder, { recursive: true });
                const pdfPath = path.join(joFolder, filename);
                fs.writeFileSync(pdfPath, pdfBuffer);

                // Store pdfPath in the JO record
                if (data.storeKey) {
                    await withFileLock(JO_FILE, async () => {
                        const db = await readJSON(JO_FILE);
                        if (db[data.storeKey]) {
                            db[data.storeKey].pdfPath = pdfPath;
                            await writeJSON(JO_FILE, db);
                        }
                    }).catch(() => {});
                }
            } catch (saveErr) {
                console.error(`[JO PDF SAVE] ❌ ${saveErr.message}`);
            }
        }

        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.contentType('application/pdf');
        res.send(pdfBuffer);

    } catch (error) {
        console.error('[generate-joborder]', error);
        res.status(500).send('Error generating JO PDF: ' + error.message);
    }
});

function generateJobOrderHTML(data, logoBase64) {
    const logoSrc = logoBase64 || '';

    const COPY_THEMES = {
        'SALES COPY':       { accentBg:'#519ef3', accentText:'#fff' },
        'OPERATIONS COPY':  { accentBg:'#519ef3', accentText:'#fff' },
        'ACCOUNTING COPY':  { accentBg:'#d500d5', accentText:'#fff' },
        'PRINTING COPY':    { accentBg:'#f5c800', accentText:'#222' },
        'FINISHING COPY':   { accentBg:'#888888', accentText:'#fff' },
    };

    const B = '#333';
    const copies = ['SALES COPY','OPERATIONS COPY','ACCOUNTING COPY','PRINTING COPY','FINISHING COPY'];
    const SIGS   = ['Operations Manager','Printing Personnel','Finishing Personnel','Accounting Personnel'];
    const pageBreak = `<div style="page-break-before:always;"></div>`;

    const buildPage = (copyLabel) => {
        const th = COPY_THEMES[copyLabel] || COPY_THEMES['SALES COPY'];
        const A = th.accentBg;
        const T = th.accentText;

        let itemRowsHTML = '';
        let imageRefBoxes = [];   // one entry per group (even if no images)

        (data.groups || []).forEach(group => {
            const items = group.items || [];
            if (!items.length) return;

            const projDisplay = group.projectName
                ? `PROJECT NAME: &nbsp;<strong>${group.projectName}</strong>`
                : 'PROJECT NAME:';
            const ctrlTag = (group.ctrlNum && group.ctrlNum !== '—')
                ? `<span style="background:#1A2B45;color:#fff;border-radius:2px;padding:1px 6px;font-family:'Courier New',monospace;font-size:14px;margin-right:6px;">${group.ctrlNum}</span>`
                : '';

            itemRowsHTML += `
            <tr>
              <td colspan="12" style="background:${A};color:${T};font-weight:bold;font-size:16px;padding:4px 8px;border:1px solid ${B};">
                ${ctrlTag}${projDisplay}
              </td>
            </tr>`;

            // Build image ref box content for this group
            let imgBoxContent = '';
            items.forEach((item, localIdx) => {
                const localSeq = localIdx + 1;
                const hasImage = item.fileData && item.fileData.startsWith('data:image/');
                if (hasImage || item.filename) {
                    imgBoxContent += `
                    <div style="margin-bottom:8px;border-top:${localIdx>0?'1px dashed #ddd':'none'};padding-top:${localIdx>0?'6px':'0'};">
                      <div style="font-size:11px;font-weight:bold;margin-bottom:3px;">#${localSeq}${item.filename ? ' — ' + item.filename : ''}</div>
                      ${hasImage ? `<img src="${item.fileData}" style="max-width:100%;max-height:90px;object-fit:contain;display:block;">` : '<div style="font-size:10px;color:#aaa;font-style:italic;">No image</div>'}
                    </div>`;
                }
            });

            imageRefBoxes.push({
                projectName: group.projectName || '',
                content: imgBoxContent
            });

            items.forEach((item, localIdx) => {
                const localSeq = localIdx + 1;
                const chk = (v) => v ? `<span style="font-size:16px;font-weight:bold;">&#10003;</span>` : '';
                const uom = (item.sizeW || item.sizeH) ? (item.sizeUnit || 'ft') : '';

                // File cell: thumbnail for images, filename text for others
                let fileCell = '';
                if (item.fileData && item.fileData.startsWith('data:image/')) {
                    fileCell = `<div style="text-align:center;"><img src="${item.fileData}" style="max-height:36px;max-width:60px;object-fit:contain;display:block;margin:0 auto;"></div>`
                             + `<div style="font-size:10px;word-break:break-all;text-align:center;color:#555;">${item.filename||''}</div>`;
                } else {
                    fileCell = item.filename || '';
                }

                itemRowsHTML += `
                <tr style="height:28px;">
                  <td style="text-align:center;border:1px solid ${B};font-size:14px;">${localSeq}</td>
                  <td style="text-align:center;border:1px solid ${B};font-size:14px;">${item.sizeW||''}</td>
                  <td style="text-align:center;border:1px solid ${B};font-size:14px;">${item.sizeH||''}</td>
                  <td style="text-align:center;border:1px solid ${B};font-size:14px;">${uom}</td>
                  <td style="vertical-align:middle;border:1px solid ${B};font-size:14px;padding:2px 4px;">${item.media||item.material||''}</td>
                  <td style="text-align:center;border:1px solid ${B};font-size:14px;">${item.qty||''}</td>
                  <td style="text-align:center;border:1px solid ${B};">${chk(item.eco)}</td>
                  <td style="text-align:center;border:1px solid ${B};">${chk(item.uv)}</td>
                  <td style="text-align:center;border:1px solid ${B};">${chk(item.plot)}</td>
                  <td style="text-align:center;border:1px solid ${B};">${chk(item.laser)}</td>
                  <td style="vertical-align:middle;border:1px solid ${B};padding:2px 4px;">${fileCell}</td>
                  <td style="vertical-align:middle;border:1px solid ${B};font-size:14px;padding:2px 4px;">${item.otherDetails||''}</td>
                </tr>`;
            });
        });

        // Build IMAGE REFERENCES grid HTML (4 columns, n rows)
        const COLS = 4;
        let imageRefRowsHTML = '';
        for (let i = 0; i < imageRefBoxes.length; i += COLS) {
            const rowBoxes = imageRefBoxes.slice(i, i + COLS);
            // If last row has < 4, pad with empty cells to center
            const isEmpty = rowBoxes.length < COLS;
            const padLeft  = isEmpty ? Math.floor((COLS - rowBoxes.length) / 2) : 0;
            const padRight = isEmpty ? COLS - rowBoxes.length - padLeft : 0;
            const cellW = `${(100/COLS).toFixed(2)}%`;

            imageRefRowsHTML += `<tr>`;
            for (let p = 0; p < padLeft; p++)  imageRefRowsHTML += `<td style="width:${cellW};border:1px solid ${B};padding:6px;"></td>`;
            rowBoxes.forEach(box => {
                imageRefRowsHTML += `
                <td style="width:${cellW};border:1px solid ${B};padding:8px;vertical-align:top;">
                  <div style="font-size:12px;font-weight:bold;margin-bottom:4px;">${box.projectName ? 'Project Name: ' + box.projectName : 'Project Name:'}</div>
                  ${box.content || '<div style="font-size:10px;color:#bbb;font-style:italic;padding:4px 0;">No attachments</div>'}
                </td>`;
            });
            for (let p = 0; p < padRight; p++) imageRefRowsHTML += `<td style="width:${cellW};border:1px solid ${B};padding:6px;"></td>`;
            imageRefRowsHTML += `</tr>`;
        }

        for (let b = 0; b < 8; b++) {
            const bd = 'border:1px solid ' + B + ';';
            itemRowsHTML += '<tr style="height:22px;">'
                + ('<td style="' + bd + '"></td>').repeat(12)
                + '</tr>';
        }

        return `
<div class="jo-page">

  <!-- HEADER: logo centered | JOB ORDER accent | JO# + copy label merged accent -->
  <table style="width:100%;border-collapse:collapse;border:2px solid ${B};">
    <tr>
      <td style="width:22%;padding:6px 8px;border-right:2px solid ${B};text-align:center;vertical-align:middle;">
        ${logoSrc
          ? `<img src="${logoSrc}" alt="Launchpad" style="max-height:40px;max-width:120px;object-fit:contain;display:block;margin:0 auto;">`
          : `<span style="font-weight:900;font-size:18px;color:#1A2B45;">LAUNCHPAD</span>`}
      </td>
      <td style="text-align:center;font-size:20px;font-weight:900;letter-spacing:2px;
                 padding:10px 4px;background:${A};color:${T};border-right:2px solid ${B};">
        JOB ORDER
      </td>
      <td style="width:28%;background:${A};color:${T};padding:6px 10px;text-align:center;vertical-align:middle;">
        <div style="font-size:18px;font-weight:900;letter-spacing:1px;font-family:'Courier New',monospace;">JO26-${data.joNumber || '____'}</div>
        <div style="font-size:13px;font-weight:bold;margin-top:3px;letter-spacing:0.5px;">${copyLabel}</div>
      </td>
    </tr>
  </table>

  <!-- CLIENT / DATE -->
  <table style="width:100%;border-collapse:collapse;border:2px solid ${B};border-top:none;">
    <tr>
      <td style="width:10%;font-weight:bold;font-size:13px;padding:4px 6px;border-right:1px solid ${B};white-space:nowrap;">CLIENT:</td>
      <td style="padding:4px 8px;border-right:2px solid ${B};font-size:14px;font-weight:bold;">${data.client||''}</td>
      <td style="width:9%;font-weight:bold;font-size:13px;padding:4px 6px;border-right:1px solid ${B};white-space:nowrap;">DATE:</td>
      <td style="padding:4px 8px;font-size:14px;">${data.displayDate||''}</td>
    </tr>
    <tr>
      <td style="font-weight:bold;font-size:13px;padding:4px 6px;border-right:1px solid ${B};border-top:1px solid ${B};white-space:nowrap;">ISSUED BY:</td>
      <td style="padding:4px 8px;border-right:2px solid ${B};border-top:1px solid ${B};font-size:14px;">${data.salesName||''}</td>
      <td style="font-weight:bold;font-size:13px;padding:4px 6px;border-right:1px solid ${B};border-top:1px solid ${B};white-space:nowrap;">TIME:</td>
      <td style="padding:4px 8px;border-top:1px solid ${B};font-size:14px;">${data.time||''}</td>
    </tr>
  </table>

  <!-- ITEMS TABLE -->
  <table style="width:100%;border-collapse:collapse;border:2px solid ${B};border-top:none;">
    <thead>
      <tr style="background:${A};color:${T};">
        <th rowspan="2" style="width:4%;text-align:center;vertical-align:middle;padding:3px 1px;border:1px solid ${B};font-size:13px;">#</th>
        <th colspan="3" style="text-align:center;padding:3px 1px;border:1px solid ${B};font-size:13px;">SIZE</th>
        <th rowspan="2" style="width:22%;text-align:center;vertical-align:middle;padding:3px 2px;border:1px solid ${B};font-size:13px;">MEDIA</th>
        <th rowspan="2" style="width:6%;text-align:center;vertical-align:middle;padding:3px 1px;border:1px solid ${B};font-size:13px;">QTY</th>
        <th rowspan="2" style="width:5%;text-align:center;vertical-align:middle;padding:3px 1px;border:1px solid ${B};font-size:13px;">GZ</th>
        <th rowspan="2" style="width:4%;text-align:center;vertical-align:middle;padding:3px 1px;border:1px solid ${B};font-size:13px;">UV</th>
        <th rowspan="2" style="width:5%;text-align:center;vertical-align:middle;padding:3px 1px;border:1px solid ${B};font-size:13px;">PLOT</th>
        <th rowspan="2" style="width:5%;text-align:center;vertical-align:middle;padding:3px 1px;border:1px solid ${B};font-size:13px;">LASER</th>
        <th rowspan="2" style="width:13%;text-align:center;vertical-align:middle;padding:3px 2px;border:1px solid ${B};font-size:13px;">FILE NAME</th>
        <th rowspan="2" style="text-align:center;vertical-align:middle;padding:3px 2px;border:1px solid ${B};font-size:13px;">OTHER DETAILS</th>
      </tr>
      <tr style="background:${A};color:${T};">
        <th style="width:6%;text-align:center;padding:2px 1px;border:1px solid ${B};font-size:13px;">W</th>
        <th style="width:6%;text-align:center;padding:2px 1px;border:1px solid ${B};font-size:13px;">H</th>
        <th style="width:6%;text-align:center;padding:2px 1px;border:1px solid ${B};font-size:13px;">UOM</th>
      </tr>
    </thead>
    <tbody>${itemRowsHTML}</tbody>
  </table>

  <!-- IMAGE REFERENCES — 4-column grid, 1 box per group -->
  <table style="width:100%;border-collapse:collapse;border:2px solid ${B};border-top:none;">
    <tr>
      <td colspan="4" style="background:${A};color:${T};font-weight:bold;font-size:13px;letter-spacing:1px;
                 text-transform:uppercase;text-align:center;padding:3px 6px;border-bottom:1px solid ${B};">
        IMAGE REFERENCES
      </td>
    </tr>
    ${imageRefRowsHTML}
  </table>

  <!-- SCHEDULE / DELIVERY — content bold, centered, larger font -->
  <table style="width:100%;border-collapse:collapse;border:2px solid ${B};border-top:none;">
    <tr>
      <td style="background:${A};color:${T};font-weight:bold;font-size:13px;letter-spacing:1px;
                 text-transform:uppercase;text-align:center;padding:3px 6px;border-bottom:1px solid ${B};">
        SCHEDULE / DELIVERY
      </td>
    </tr>
    <tr>
      <td style="padding:10px 12px;font-size:16px;font-weight:bold;text-align:center;min-height:44px;">
        ${data.deadline || '&nbsp;'}
      </td>
    </tr>
  </table>

  <!-- GENERAL REMARKS — content bold, centered, larger font -->
  <table style="width:100%;border-collapse:collapse;border:2px solid ${B};border-top:none;">
    <tr>
      <td style="background:${A};color:${T};font-weight:bold;font-size:13px;letter-spacing:1px;
                 text-transform:uppercase;text-align:center;padding:3px 6px;border-bottom:1px solid ${B};">
        GENERAL REMARKS
      </td>
    </tr>
    <tr>
      <td style="padding:10px 12px;font-size:16px;font-weight:bold;text-align:center;min-height:44px;">
        ${data.specialInstructions || '&nbsp;'}
      </td>
    </tr>
  </table>

  <!-- SIGNATURES — all black, no accent color, no ink waste -->
  <table style="width:100%;border-collapse:collapse;border:2px solid ${B};border-top:none;">
    <tr>
      ${SIGS.map((name, i) => `
      <td style="width:25%;${i < SIGS.length-1 ? `border-right:1px solid ${B};` : ''}
                 padding:6px 8px 5px;text-align:center;vertical-align:bottom;">
        <div style="font-size:11px;color:#333;text-align:left;margin-bottom:18px;">Received by:</div>
        <div style="border-bottom:1px solid #333;margin:0 6px 3px;"></div>
        <div style="font-size:11px;color:#333;">
          <strong>${name}</strong>&nbsp;|&nbsp;Name &amp; Date
        </div>
      </td>`).join('')}
    </tr>
  </table>

</div>`;
    };

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:Calibri,'Calibri',Arial,sans-serif; color:#000; background:white; }
  .jo-page { width:7.27in; margin:0 auto; padding:0; }
  table td, table th { vertical-align:middle; }
</style>
</head>
<body>
  ${copies.map((label, i) => (i > 0 ? pageBreak : '') + buildPage(label)).join('')}
</body>
</html>`;
}

// ── Puppeteer: one shared browser instance ────────────────────────────────────
// We launch the browser once and reuse it; each request opens and closes a
// cheap new tab. If the browser crashes/disconnects the next request
// transparently relaunches it.
//
// FIX: The previous implementation had a race condition. If the browser crashed
// while two requests were in-flight, both would see (browserInstance=null,
// browserLaunching=null) simultaneously and each would start its own Chromium
// launch. The second launch could clash with the first's still-connecting
// WebSocket, causing "Target closed / Protocol error" on the retry path.
//
// Solution: serialize ALL launch attempts through a single Mutex so only one
// launch can run at a time. Concurrent callers wait on the same promise.
let browserInstance = null;
const browserMutex = new Mutex();

function isBrowserAlive(b) {
    if (!b) return false;
    if (typeof b.isConnected === 'function') return b.isConnected();
    try { return b.process() !== null; } catch { return false; }
}

const PUPPETEER_ARGS = [
    '--no-sandbox', '--disable-setuid-sandbox',
    '--disable-dev-shm-usage', '--disable-gpu',
    '--memory-pressure-off',
];

async function getBrowser() {
    // Fast path: browser is alive, no lock needed.
    if (isBrowserAlive(browserInstance)) return browserInstance;

    // Slow path: serialize through mutex so concurrent requests share one launch.
    return browserMutex.run(async () => {
        // Re-check inside the lock — another waiter may have launched already.
        if (isBrowserAlive(browserInstance)) return browserInstance;

        // Close any zombie instance before launching a new one.
        if (browserInstance) {
            await browserInstance.close().catch(() => {});
            browserInstance = null;
        }

        const browser = await puppeteer.launch({
            headless: true,   // 'new' is deprecated in Puppeteer ≥22; true is the correct value
            args: PUPPETEER_ARGS,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        });

        browserInstance = browser;
        browser.on('disconnected', () => {
            console.warn('[Browser] Disconnected — will relaunch on next request.');
            browserInstance = null;
        });
        return browser;
    });
}

// ── renderPDF: wraps page lifecycle + retries once on browser crash ───────────
async function renderPDF(html, pdfOptions) {
    pdfOptions = pdfOptions || {
        format: 'A4',
        printBackground: true,
        margin: { top: '0.3in', right: '0.3in', bottom: '0.3in', left: '0.3in' }
    };

    async function attempt() {
        const browser = await getBrowser();
        const page = await browser.newPage();
        try {
            await page.setContent(html, { waitUntil: 'load', timeout: 60000 });
            return await page.pdf(pdfOptions);
        } finally {
            await page.close().catch(() => {});
        }
    }

    try {
        return await attempt();
    } catch (err) {
        const isRecoverable = err.message && (
            err.message.includes('Target closed') ||
            err.message.includes('Session closed') ||
            err.message.includes('Protocol error')
        );
        if (isRecoverable) {
            console.warn('[renderPDF] Browser error, forcing relaunch and retrying…', err.message);
            // Force-clear so getBrowser() definitely launches a fresh instance.
            if (browserInstance) {
                await browserInstance.close().catch(() => {});
                browserInstance = null;
            }
            return await attempt(); // one retry with a fresh browser
        }
        throw err;
    }
}

// ── Logo: read from disk once, then serve from memory ─────────────────────────
let cachedLogoBase64 = null;
function getLogoBase64() {
    if (cachedLogoBase64 !== null) return cachedLogoBase64;
    try {
        const logoPath = path.join(__dirname, 'public', 'logo.png');
        cachedLogoBase64 = fs.existsSync(logoPath)
            ? 'data:image/png;base64,' + fs.readFileSync(logoPath).toString('base64')
            : '';
    } catch {
        cachedLogoBase64 = '';
    }
    return cachedLogoBase64;
}

app.post('/api/generate-quotation', async (req, res) => {
    let page = null;
    try {
        const data = req.body;

        // Validate: need at least in-house OR outsource OR flat rate items
        const hasInHouse   = data.items && data.items.length > 0;
        const hasOutsource = data.outsourceItems && data.outsourceItems.length > 0;
        const hasFlatRate  = data.flatRateItems && data.flatRateItems.length > 0;
        if (!hasInHouse && !hasOutsource && !hasFlatRate) {
            return res.status(400).send('No items provided. Please add at least one item.');
        }

        // Calculate totals
        // NOTE: item.unitPrice arrives already fully computed from the frontend —
        // it already bakes in W × H, any multipliers, AND add-on materials.
        // Do NOT multiply by W × H again here.
        data.items = data.items.map(item => {
            const price = parseFloat(item.unitPrice) || 0;
            const qty   = parseInt(item.quantity) || 0;
            const total = price * qty;
            return { ...item, totalAmount: total.toFixed(2) };
        });

        // Compute outsource item totals
        data.outsourceItems = (data.outsourceItems || []).map(item => {
            const price = parseFloat(item.unitPrice) || 0;
            const qty   = parseInt(item.quantity) || 0;
            const total = price * qty;
            // Build formula string: base × m1 × m2 ...
            const mults = item.multipliers || [];
            const formulaParts = [item.basePrice, ...mults];
            const formula = mults.length > 0 ? formulaParts.join(' × ') : String(item.basePrice);
            return { ...item, totalAmount: total.toFixed(2), formula };
        });

        // Compute flat rate item totals
        data.flatRateItems = (data.flatRateItems || []).map(item => {
            const price = parseFloat(item.unitPrice) || 0;
            const qty   = parseInt(item.quantity) || 0;
            const total = price * qty;
            return { ...item, totalAmount: total.toFixed(2) };
        });

        data.grandTotal = (
            data.items.reduce((sum, item) => sum + parseFloat(item.totalAmount), 0) +
            data.outsourceItems.reduce((sum, item) => sum + parseFloat(item.totalAmount), 0) +
            data.flatRateItems.reduce((sum, item) => sum + parseFloat(item.totalAmount), 0)
        ).toFixed(2);

        // Logo as base64 so Puppeteer can render it without an HTTP round-trip
        // (cached after the first request — no repeated disk reads)
        const logoBase64 = getLogoBase64();

        // Format the date nicely (YYYY-MM-DD → Month DD, YYYY)
        if (data.date) {
            const [y, m, d] = data.date.split('-');
            const months = ['January','February','March','April','May','June',
                            'July','August','September','October','November','December'];
            data.date = `${months[parseInt(m) - 1]} ${parseInt(d)}, ${y}`;
        }

        const html = generateQuotationHTML(data, logoBase64);

        const pdfBuffer = await renderPDF(html, {
            width: '8.5in',
            height: '13in',
            printBackground: true,
            margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' }
        });

        // ── Build filename: Q26_XXXX Company - Project Name (- RevN if revised) ──
        const ctrl        = data.controlNumber  || 'Q26_0000';
        const company     = (data.company      || 'Quotation').replace(/[^a-z0-9_\- ]/gi, '_');
        const project     = (data.projectName  || '').replace(/[^a-z0-9_\- ]/gi, '_').trim();
        const revNum      = parseInt(data.revisionNumber) || 0;
        const revSuffix   = revNum > 0 ? ` - Rev${revNum}` : '';
        const projPart    = project ? ` - ${project}` : '';
        const salesPerson = (data.salesName || '').replace(/[^a-z0-9_\- ]/gi, '_').trim();
        const salesPart   = salesPerson ? ` - ${salesPerson}` : '';
        const filename    = `${ctrl} ${company}${projPart}${revSuffix}${salesPart}.pdf`;

        // ── Auto-save PDF to Google Drive folder (per-company subfolder) ────────
        // Skipped for dev/test previews (data.skipDriveSave) so testing the form
        // doesn't litter the shared Drive with throwaway company folders/PDFs.
        if (data.skipDriveSave) {
            console.log(`[PDF SAVE] ⏭️  Skipped (preview/dev request): ${filename}`);
        } else {
            try {
                const companyFolderName = (data.company || 'Unknown')
                    .replace(/[<>:"/\\|?*]/g, '_')  // illegal chars
                    .replace(/[. ]+$/, '')            // Windows forbids trailing dots/spaces
                    .trim() || 'Unknown';
                const companyFolder = path.join(DRIVE_FOLDER, companyFolderName);

                console.log(`[PDF SAVE] Company folder: ${companyFolder}`);
                console.log(`[PDF SAVE] Exists before mkdir: ${fs.existsSync(companyFolder)}`);

                // Cross-platform: fs.mkdirSync with recursive works on Linux (Railway),
                // Windows local, and mapped/network drives alike.
                if (!fs.existsSync(companyFolder)) {
                    fs.mkdirSync(companyFolder, { recursive: true });
                }

                console.log(`[PDF SAVE] Exists after mkdir: ${fs.existsSync(companyFolder)}`);

                const targetFolder = fs.existsSync(companyFolder) ? companyFolder : DRIVE_FOLDER;
                if (targetFolder === DRIVE_FOLDER) {
                    console.warn(`[PDF SAVE] ⚠️  Subfolder still missing — saving to root`);
                }

                const pdfPath = path.join(targetFolder, filename);
                console.log(`[PDF SAVE] Writing PDF to: ${pdfPath}`);
                fs.writeFileSync(pdfPath, pdfBuffer);
                console.log(`[PDF SAVE] ✅ Saved successfully`);

                // Store the saved PDF path back into the quote snapshot so delete can find it
                if (data.storeKey) {
                    try {
                        await withFileLock(QUOTES_FILE, async () => {
                            const db = await readJSON(QUOTES_FILE);
                            if (db[data.storeKey]) {
                                db[data.storeKey].pdfPath = pdfPath;
                                await writeJSON(QUOTES_FILE, db);
                            }
                        });
                    } catch {}
                }
            } catch (saveErr) {
                console.error(`[PDF SAVE] ❌ Failed: ${saveErr.message} (code: ${saveErr.code})`);
            }
        }

        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.contentType('application/pdf');
        res.send(pdfBuffer);

    } catch (error) {
        console.error('[generate-quote]', error);
        res.status(500).send('Error generating PDF: ' + error.message);
    } finally {
        // If we threw before reaching page.close() above, make sure the tab
        // still gets cleaned up so it can't leak across requests.
        if (page) await page.close().catch(() => {});
    }
});

function generateQuotationHTML(data, logoBase64) {
    const formatCurrency = (num) =>
        parseFloat(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const logoSrc = logoBase64 || '';
    const logoTag = logoSrc
        ? `<img src="${logoSrc}" alt="Launchpad Logo" style="max-width:250px;height:auto;margin-bottom:10px;">`
        : `<div style="font-size:20px;font-weight:bold;margin-bottom:10px;">LAUNCHPAD HOLDINGS OPC</div>`;

    // Revision badge for the PDF
    const revNum    = parseInt(data.revisionNumber) || 0;
    const revBadge  = revNum > 0
        ? `<span style="display:inline-block;background:#e74c3c;color:white;font-size:11px;font-weight:bold;padding:2px 8px;border-radius:3px;margin-left:8px;">Rev ${revNum}</span>`
        : '';

    return `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; padding: 20px; color: #000; font-size: 13px; line-height: 1.4; width: 7.5in; margin: 0 auto; }
    .header { text-align: center; margin-bottom: 25px; position: relative; }
    .company-info { font-size: 11px; color: #333; margin-top: 5px; line-height: 1.5; }
    .title { font-size: 22px; font-weight: bold; margin: 20px 0; text-transform: uppercase; letter-spacing: 0.5px; }

    /* Control number — top-right corner */
    .ctrl-block {
        position: absolute;
        top: 0;
        right: 0;
        text-align: right;
        font-size: 11px;
        color: #555;
        line-height: 1.6;
    }
    .ctrl-block .ctrl-num {
        font-size: 13px;
        font-weight: bold;
        color: #2c3e50;
        font-family: 'Courier New', monospace;
        letter-spacing: 0.5px;
    }

    .info-container { display: flex; justify-content: space-between; margin-bottom: 20px; }
    .info-column { width: 48%; }
    .info-row { display: flex; margin-bottom: 6px; }
    .label { font-weight: bold; width: 110px; flex-shrink: 0; }
    .value { flex-grow: 1; }

    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th { border-top: 1px solid #000; border-bottom: 1px solid #000; padding: 10px 6px; text-align: left; font-weight: bold; }
    td { padding: 10px 6px; border-bottom: 1px solid #eee; vertical-align: top; }
    .text-center { text-align: center; }
    .text-right  { text-align: right; }
    .total-row td { font-weight: bold; border-top: 1px solid #000; border-bottom: 1px solid #000; padding-top: 12px; }

    .terms-section { margin: 20px 0; font-size: 11.5px; line-height: 1.5; }
    .terms-section p { margin: 1.5em 0 0 0; }
    .terms-section p:first-child { margin-top: 0; }
    .signature-container { margin-top: 40px; display: flex; justify-content: space-between; }
    .sig-box { width: 45%; }
    .sig-line { border-top: 1px solid #000; margin-top: 50px; padding-top: 5px; width: 220px; }
  </style>
</head>
<body>
  <div class="header">
    ${logoTag}
    <div class="company-info">
      Unit 3006 One Corporate Centre Building, Julia Vargas Avenue,<br>
      Ortigas Center San Antonio Pasig City<br>
      ${data.salesContact || '+63924-316-7302'} / ${data.salesEmail || 'russ.castaloni@launchpadph.com'}
    </div>

    <!-- Control Number top-right -->
    <div class="ctrl-block">
      <div>Control No.</div>
      <div class="ctrl-num">${data.controlNumber || ''}${revBadge}</div>
    </div>
  </div>

  <div class="title">PRICE QUOTATION</div>

  <div class="info-container">
    <div class="info-column">
      <div class="info-row"><span class="label">Company:</span><span class="value">${data.company || ''}</span></div>
      <div class="info-row"><span class="label">Address:</span><span class="value">${data.address || ''}</span></div>
      <div class="info-row"><span class="label">TIN #:</span><span class="value">${data.tin || ''}</span></div>
      <div class="info-row"><span class="label">Attention To:</span><span class="value">${data.attentionTo || ''}</span></div>
      ${data.projectName ? `<div class="info-row"><span class="label">Project:</span><span class="value" style="font-weight:bold;color:#2c3e50;">${data.projectName}</span></div>` : ''}
    </div>
    <div class="info-column">
      <div class="info-row"><span class="label">Date:</span><span class="value">${data.date || ''}</span></div>
      <div class="info-row"><span class="label">Contact No.:</span><span class="value">${formatPhone(data.tel || '')}</span></div>
    </div>
  </div>

  <p style="margin-bottom: 15px;"><strong>To Whom It May Concern,</strong></p>
  <p style="margin-bottom: 20px;">Greetings! Thank you for giving us an opportunity to serve you. Here is our quotation for the following items for your consideration and approval.</p>

  <table>
    <thead>
      <tr>
        <th style="width:31%;">Materials</th>
        <th class="text-center" style="width:8%;">W</th>
        <th class="text-center" style="width:4%;"></th>
        <th class="text-center" style="width:8%;">H</th>
        <th class="text-center" style="width:10%;">Size</th>
        <th class="text-right"  style="width:15%;">Unit Price</th>
        <th class="text-center" style="width:8%;">Quantity</th>
        <th class="text-right"  style="width:16%;">Total Amount</th>
      </tr>
    </thead>
    <tbody>
      ${data.items.map(item => `
        <tr>
          <td>${item.material || ''}</td>
          <td class="text-center">${item.sizeW !== '' && item.sizeW != null ? item.sizeW : '—'}</td>
          <td class="text-center">${(item.sizeW !== '' && item.sizeW != null && item.sizeH !== '' && item.sizeH != null) ? 'x' : ''}</td>
          <td class="text-center">${item.sizeH !== '' && item.sizeH != null ? item.sizeH : '—'}</td>
          <td class="text-center">${item.sizeUnit || ''}</td>
          <td class="text-right">${item.unitPrice ? formatCurrency(item.unitPrice) : ''}</td>
          <td class="text-center">${item.quantity || ''}</td>
          <td class="text-right">${formatCurrency(item.totalAmount)}</td>
        </tr>
      `).join('')}
      ${(data.outsourceItems || []).map(item => `
        <tr>
          <td>${item.material || ''}</td>
          <td class="text-center">${item.sizeW ? item.sizeW : '—'}</td>
          <td class="text-center">${(item.sizeW && item.sizeH) ? 'x' : ''}</td>
          <td class="text-center">${item.sizeH ? item.sizeH : '—'}</td>
          <td class="text-center">${item.sizeUnit || ''}</td>
          <td class="text-right">${item.unitPrice ? formatCurrency(item.unitPrice) : ''}</td>
          <td class="text-center">${item.quantity || ''}</td>
          <td class="text-right">${formatCurrency(item.totalAmount)}</td>
        </tr>
      `).join('')}
      ${(data.flatRateItems || []).map(item => `
        <tr>
          <td>${item.material || ''}</td>
          <td class="text-center"></td>
          <td class="text-center"></td>
          <td class="text-center"></td>
          <td class="text-center"></td>
          <td class="text-right">${item.unitPrice ? formatCurrency(item.unitPrice) : ''}</td>
          <td class="text-center">${item.quantity || ''}</td>
          <td class="text-right">${formatCurrency(item.totalAmount)}</td>
        </tr>
      `).join('')}
      ${data.includeVat ? (() => {
        const gt   = parseFloat(data.grandTotal);
        const vat  = gt - (gt / 1.12);
        const base = gt / 1.12;
        return `
      <tr>
        <td colspan="6"></td>
        <td class="text-right" style="font-size:11px;color:#555;padding-top:10px;">Amount before VAT:</td>
        <td class="text-right" style="font-size:11px;color:#555;padding-top:10px;">PHP ${formatCurrency(base)}</td>
      </tr>
      <tr>
        <td colspan="6"></td>
        <td class="text-right" style="font-size:11px;color:#555;">VAT (12% incl.):</td>
        <td class="text-right" style="font-size:11px;color:#555;">PHP ${formatCurrency(vat)}</td>
      </tr>`;
      })() : ''}
      <tr class="total-row">
        <td colspan="6"></td>
        <td class="text-center">TOTAL:</td>
        <td class="text-right">PHP ${formatCurrency(data.grandTotal)}</td>
      </tr>
    </tbody>
  </table>

  ${(!data.includeVat && !data.vatExclusive) ? '<p><strong>* Note: Prices are Inclusive of VAT</strong></p>' : ''}
  <p style="margin-top: 5px;"><strong>LEAD TIME:</strong> ${data.leadTime || '____'} Working Days, Upon Confirmation</p>

  <!-- ── Terms always start on a new page ── -->
  <div class="terms-section" style="page-break-before: always;">
    <p style="margin-bottom:8px;"><strong>TERMS &amp; CONDITIONS:</strong></p>

    <p><strong>Price Validity: 15 Days</strong></p>

    <p><em>*Sundays and holidays are not included in the cost.</em></p>

    <p><strong>Payment Terms: ${data.paymentTerms || 'COD for first time customers'}.<br>
    We require at least 50% down payment for bulk orders (Php 500k and above) and customized/personalized items before production starts. Email or text us to let us know when payment is made for confirmation purposes. Once payment is confirmed or cleared (for cheque payments) we will arrange the design proofing &amp; production of your order as soon as possible.</strong></p>

    <p>
      <strong>*After design proof/sample approval no revisions/refunds can be made unless approved by both parties<br>
      *Above prices may vary depending on design and quantity<br>
      *Prices for other plastic banner/poster designs are also available upon request<br>
      *Prices are subject to change without prior notice</strong>
    </p>

    ${(function(){
      var banks = data.bankDetails ? data.bankDetails.split(',') : ['bdo','ub','gcash'];
      var has = function(v){ return banks.includes(v); };
      var out = '';
      if(has('bdo'))   out += '<p><strong>Bank Payment Details:<br>Banco De Oro (BDO)<br>Bank Account Name: LAUNCHPAD HOLDINGS OPC<br>Bank Account Number: 000668097626</strong></p>';
      if(has('ub'))    out += '<p><strong>Bank Payment Details:<br>UnionBank (UB)<br>Bank Account Name: LAUNCHPAD HOLDINGS OPC<br>Bank Account Number: 000910035428</strong></p>';
      if(has('gcash')) out += '<p><strong>GCash:<br>Account Name: V******* T.<br>Account Number: 0961 929 3603</strong></p>';
      return out;
    })()}

    <p>
      1. Late Payments shall be charge a penalty of 2% per month compounded or 24% Annually. Partial Payments shall be first applied to accumulated penalties, interest, then principal balance in that order.<br>
      2. This quotation serves as the official agreement between LAUNCHPAD HOLDINGS OPC and the COMPANY listed above.<br>
      3. A high resolution file should be supplied by the client.<br>
      4. Should the client decide to terminate the contract during fabrication and design conception including mock-up/sampler, a bill will still be issued up to the point where the project has been stopped.<br>
      5. The fees/breakdown is PACKAGED COST, Launchpad Holdings OPC shall not forbear liquidation.
    </p>

    <p>
      <strong>COLOR &amp; APPEARANCE DISCLAIMER:</strong><br>
      Due to the many variations in monitors and browsers, color samples and appearance may appear different on different monitors. Computer and mobile device monitors are not all calibrated equally and color and appearance reproduction on the internet is not precise. Since it is not possible to guarantee our online colors and appearance will look the same on all computers and devices, we cannot guarantee that what you see on your monitors accurately portrays the color and appearance of the actual finished product.
    </p>

    <p>
      We hope that this quotation merits your humble company's approval.<br>
      As you signify your conformity, this letter shall serve as our contract.
    </p>
  </div>

  <div class="signature-container">
    <div class="sig-box">
      <p><strong>Sincerely,</strong></p>
      ${data.salesSignature
        ? `<div style="margin-top:10px;margin-bottom:4px;"><img src="${data.salesSignature}" alt="Signature" style="max-height:60px;max-width:200px;object-fit:contain;"></div>`
        : '<div style="height:60px;margin-top:10px;"></div>'
      }
      <div class="sig-line" style="margin-top:4px;">
        <strong>${data.salesName || 'Narine Canales'}</strong><br>
        ${data.salesPosition || 'General Manager'}
      </div>
    </div>
    <div class="sig-box" style="display:flex;flex-direction:column;align-items:flex-end;">
      <div style="width:220px;">
        <p><strong>Conforme:</strong></p>
        <div style="border:1px dashed #000;height:80px;margin:15px 0;"></div>
        <p style="text-align:center;font-size:11px;font-weight:bold;">Authorized Signature / Date</p>
      </div>
    </div>
  </div>
</body>
</html>
    `;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROFILES API
// ═══════════════════════════════════════════════════════════════════════════════

/* Format Philippine mobile/landline numbers for PDF display.
   e.g. "09123456789" → "0912 345 6789", "+639123456789" → "+63 912 345 6789" */
function formatPhone(raw) {
    const digits = raw.replace(/\D/g, '');
    // Philippine mobile: 11 digits starting with 09 → 0XXX XXX XXXX
    if (/^09\d{9}$/.test(digits)) {
        return digits.slice(0,4) + ' ' + digits.slice(4,7) + ' ' + digits.slice(7);
    }
    // International format: 639XXXXXXXXX → +63 9XX XXX XXXX
    if (/^639\d{9}$/.test(digits)) {
        return '+63 ' + digits.slice(2,5) + ' ' + digits.slice(5,8) + ' ' + digits.slice(8);
    }
    // Fallback: return as-is
    return raw;
}

/* Simple PIN hash (SHA-256). Not bcrypt, but good enough for an internal tool. */
function hashPin(pin) {
    return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

/* Admin token middleware */
function requireAdmin(req, res, next) {
    if (req.headers['x-admin-token'] === ADMIN_TOKEN) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// POST /api/admin/login  — returns a session token
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        res.json({ token: ADMIN_TOKEN });
    } else {
        res.status(401).json({ error: 'Incorrect password' });
    }
});

// GET /api/profiles — returns profile list (strips PIN hash; includes signature for admin, strips for reps)
app.get('/api/profiles', async (req, res) => {
    try {
        const db = await withFileLock(PROFILES_FILE, () => readJSON(PROFILES_FILE));
        const isAdmin = req.headers['x-admin-token'] === ADMIN_TOKEN;
        const list = Object.values(db).map(p => ({
            id:        p.id,
            name:      p.name,
            position:  p.position,
            contact:   p.contact,
            email:     p.email,
            signature: p.signature || null   // include for both; login page doesn't use it, app.js will fetch full profile
        }));
        res.json(list);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/profiles — add a new profile (admin only)
app.post('/api/profiles', requireAdmin, async (req, res) => {
    try {
        const { name, position, contact, email, pin, signature } = req.body;
        if (!name || !position || !contact || !email || !pin) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        if (String(pin).length !== 4 || !/^\d{4}$/.test(String(pin))) {
            return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
        }

        const id = crypto.randomBytes(8).toString('hex');
        const profile = { id, name, position, contact, email, pinHash: hashPin(pin), signature: signature || null, createdAt: new Date().toISOString() };

        await withFileLock(PROFILES_FILE, async () => {
            const db = await readJSON(PROFILES_FILE);
            db[id] = profile;
            await writeJSON(PROFILES_FILE, db);
        });
        res.json({ ok: true, id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// DELETE /api/profiles/:id  (admin only)
app.delete('/api/profiles/:id', requireAdmin, async (req, res) => {
    try {
        const id = decodeURIComponent(req.params.id);
        await withFileLock(PROFILES_FILE, async () => {
            const db = await readJSON(PROFILES_FILE);
            delete db[id];
            await writeJSON(PROFILES_FILE, db);
        });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// PUT /api/profiles/:id  — edit profile info (admin only)
app.put('/api/profiles/:id', requireAdmin, async (req, res) => {
    try {
        const id = decodeURIComponent(req.params.id);
        const { name, position, contact, email, signature } = req.body;
        if (!name || !position || !contact || !email) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        await withFileLock(PROFILES_FILE, async () => {
            const db = await readJSON(PROFILES_FILE);
            if (!db[id]) return res.status(404).json({ error: 'Profile not found' });
            db[id].name      = name;
            db[id].position  = position;
            db[id].contact   = contact;
            db[id].email     = email;
            if (signature !== undefined) db[id].signature = signature;
            await writeJSON(PROFILES_FILE, db);
        });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// PUT /api/profiles/:id/pin  — change PIN (admin only)
app.put('/api/profiles/:id/pin', requireAdmin, async (req, res) => {
    try {
        const id  = decodeURIComponent(req.params.id);
        const { pin } = req.body;
        if (!pin || !/^\d{4}$/.test(String(pin))) return res.status(400).json({ error: 'Invalid PIN' });

        await withFileLock(PROFILES_FILE, async () => {
            const db = await readJSON(PROFILES_FILE);
            if (!db[id]) return res.status(404).json({ error: 'Profile not found' });
            db[id].pinHash  = hashPin(pin);
            await writeJSON(PROFILES_FILE, db);
        });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/profiles/login  — verify name + PIN, return profile (no PIN hash)
app.post('/api/profiles/login', async (req, res) => {
    try {
        const { id, pin } = req.body;
        if (!id || !pin) return res.status(400).json({ error: 'Missing id or pin' });

        const db = await withFileLock(PROFILES_FILE, () => readJSON(PROFILES_FILE));
        const profile = db[id];
        if (!profile) return res.status(404).json({ error: 'Profile not found' });

        if (profile.pinHash !== hashPin(pin)) {
            return res.status(401).json({ error: 'Incorrect PIN' });
        }

        // Return safe profile (no pinHash)
        const { pinHash, ...safe } = profile;
        res.json(safe);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── End of Profiles API ─────────────────────────────────────────────────────

// ═══════════════════════════════════════
// BULK IMPORT API (one-time migration)
// ═══════════════════════════════════════

app.post("/api/import/profiles", requireAdmin, async (req, res) => {
    try {
        const { profiles } = req.body;
        if (!profiles) return res.status(400).json({ error: "Missing profiles" });
        await withFileLock(PROFILES_FILE, () => writeJSON(PROFILES_FILE, profiles));
        res.json({ ok: true, count: Object.keys(profiles).length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/import/quotes", requireAdmin, async (req, res) => {
    try {
        const { quotes } = req.body;
        if (!quotes) return res.status(400).json({ error: "Missing quotes" });
        await withFileLock(QUOTES_FILE, () => writeJSON(QUOTES_FILE, quotes));
        res.json({ ok: true, count: Object.keys(quotes).length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/import/serials", requireAdmin, async (req, res) => {
    try {
        const { serials } = req.body;
        if (!serials) return res.status(400).json({ error: "Missing serials" });
        await withFileLock(SERIALS_FILE, () => writeJSON(SERIALS_FILE, serials));
        res.json({ ok: true, count: Object.keys(serials).length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Drive folder: ${DRIVE_FOLDER}`);
    console.log(`Drive folder accessible: ${fs.existsSync(DRIVE_FOLDER)}`);
    if (!fs.existsSync(DRIVE_FOLDER)) {
        console.warn(`⚠️  WARNING: Drive folder NOT found! PDFs and quotes will not save.`);
        console.warn(`   Make sure Google Drive is running and the path is correct.`);
    } else {
        console.log(`✅ Drive folder OK — quotes and PDFs will save there.`);
    }
    // Pre-launch the browser at startup so the very first PDF request
    // doesn't have to pay the ~1-2s Chromium cold-start cost.
    getBrowser().then(() => console.log('✅ Puppeteer browser pre-launched and ready.'))
                .catch(err => console.error('⚠️  Failed to pre-launch browser:', err.message));
});

// ── Graceful shutdown: close the shared browser cleanly ───────────────────────
async function shutdown(signal) {
    console.log(`\n${signal} received, shutting down...`);
    if (browserInstance) await browserInstance.close().catch(() => {});
    process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
