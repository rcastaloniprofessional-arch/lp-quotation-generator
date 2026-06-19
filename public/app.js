        /* ═══════════════════════════════════════════════════════
           STORAGE → server API (Google Drive backed)
           All quote data lives in G:\Shared drives\...\lp_quotes.json
           Serials live in lp_serials.json in the same folder
        ═══════════════════════════════════════════════════════ */

        // Auto-detect server — works whether opened as localhost or via IP from another computer
        const API = window.location.origin;

        function toggleOtherPayment() {
            const sel = document.getElementById('paymentTerms');
            const grp = document.getElementById('otherPaymentGroup');
            const inp = document.getElementById('otherPaymentTerms');
            if (sel.value === 'others') {
                grp.style.display = '';
                inp.required = true;
            } else {
                grp.style.display = 'none';
                inp.required = false;
                inp.value = '';
            }
        }

        function companyKey(name) {
            return (name || '').trim().toLowerCase();
        }

        function buildControlNumber(serial) {
            return `Q26_${String(serial).padStart(4, '0')}`;
        }

        /* ── State ── */
        let currentControlNumber = '';
        let currentRevision      = 0;
        let _loadedFromSnapshot  = false;
        let _loadedStoreKey      = null;   // storeKey of the quote currently loaded (null = new quote)
        let _cachedDb            = null;   // in-memory cache so UI stays snappy

        /* Load quotes from server (with cache) */
        async function loadDB(force = false) {
            if (_cachedDb && !force) return _cachedDb;
            try {
                const r = await fetch(`${API}/api/quotes`);
                _cachedDb = await r.json();
            } catch { _cachedDb = {}; }
            return _cachedDb;
        }

        /* Save one quote to server */
        async function saveQuote(storeKey, snapshot) {
            await fetch(`${API}/api/quotes`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ storeKey, snapshot })
            });
            if (_cachedDb) _cachedDb[storeKey] = snapshot; // update cache
        }

        /* Delete one quote from server */
        async function deleteQuoteFromServer(storeKey) {
            await fetch(`${API}/api/quotes/${encodeURIComponent(storeKey)}`, { method: 'DELETE' });
            if (_cachedDb) delete _cachedDb[storeKey];
        }

        /* Reset serial for a company key on the server */
        async function resetSerial(companyKeyStr) {
            try {
                await fetch(`${API}/api/serials/${encodeURIComponent(companyKeyStr)}`, { method: 'DELETE' });
            } catch {}
        }

        /* After deleting quotes, recalculate serials so they reflect the highest
           remaining quote number for each company. If a company has no quotes left,
           its serial is removed entirely so numbering restarts from 1. */
        async function syncSerialsAfterDelete() {
            const db = _cachedDb || {};

            // Build a map of companyKey → highest serial number still in DB
            // storeKey format: Q26_XXXX|companykey|revN
            // The serial number is the numeric part of the control number (e.g. 0003 → 3)
            const highestSerial = {};
            Object.keys(db).forEach(k => {
                const parts = k.split('|');
                if (parts.length < 2) return;
                const ctrlNum  = parts[0]; // e.g. "Q26_0003"
                const cKey     = parts[1]; // e.g. "toyota"
                const match    = ctrlNum.match(/Q\d+_(\d+)/);
                if (!match) return;
                const num = parseInt(match[1], 10);
                if (!highestSerial[cKey] || num > highestSerial[cKey]) {
                    highestSerial[cKey] = num;
                }
            });

            // Get all serial keys currently on the server
            try {
                const r = await fetch(`${API}/api/serials`);
                const serials = await r.json();

                for (const key of Object.keys(serials)) {
                    const correct = highestSerial[key] || 0;
                    if (correct === 0) {
                        // No quotes left for this company — remove serial entirely
                        await resetSerial(key);
                    } else if (serials[key] !== correct) {
                        // Set serial to the highest remaining quote number
                        await fetch(`${API}/api/serials/${encodeURIComponent(key)}`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ value: correct })
                        });
                    }
                }
            } catch {}
        }

        /* Peek next serial for company (no commit) */
        async function peekNextSerial(companyName) {
            try {
                const r = await fetch(`${API}/api/serials/peek?companyKey=${encodeURIComponent(companyKey(companyName))}`);
                const j = await r.json();
                return j.serial;
            } catch { return 1; }
        }

        /* Commit serial for company → returns the new serial number */
        async function commitSerial(companyName) {
            const r = await fetch(`${API}/api/serials/next`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ companyKey: companyKey(companyName) })
            });
            const j = await r.json();
            return j.serial;
        }

        /* ── Control number init & live preview ── */
        async function initControlNumber() {
            const serial = await peekNextSerial('');
            currentControlNumber = buildControlNumber(serial);
            currentRevision = 0;
            _loadedStoreKey = null;
            refreshCtrlDisplay();
            resetLoadedMode();
        }

        /* Debounce helper */
        let _peekTimer = null;
        document.getElementById('company').addEventListener('input', function() {
            if (_loadedFromSnapshot) return;
            clearTimeout(_peekTimer);
            const name = this.value;
            _peekTimer = setTimeout(async () => {
                const serial = await peekNextSerial(name);
                currentControlNumber = buildControlNumber(serial);
                refreshCtrlDisplay();
            }, 300);
        });

        function refreshCtrlDisplay() {
            document.getElementById('ctrlDisplay').textContent = currentControlNumber;
            const revEl = document.getElementById('ctrlRevDisplay');
            revEl.textContent = currentRevision > 0 ? `Rev${currentRevision}` : '';
        }

        /* ── Snapshot helpers ── */
        function captureSnapshot() {
            const items = [];
            document.querySelectorAll('#items .item-wrapper').forEach(wrapper => {
                const row = wrapper.querySelector('.item-row');

                const multipliers = [];
                wrapper.querySelectorAll('.multVal').forEach(inp => {
                    multipliers.push(parseFloat(inp.value) || 0);
                });

                const addons = [];
                wrapper.querySelectorAll('.addon-tag').forEach(tag => {
                    addons.push({
                        desc:  tag.querySelector('.addon-desc').value,
                        price: parseFloat(tag.querySelector('.addon-price').value) || 0,
                        qty:   parseFloat(tag.querySelector('.addon-qty').value)   || 1
                    });
                });

                const manualBtn = wrapper.querySelector('[id^="btnManual"]');
                const isManual  = manualBtn ? manualBtn.classList.contains('active') : false;
                const formulaInp = wrapper.querySelector('[id^="manualFormula"]:not([id^="manualFormulaR"])');

                items.push({
                    material:           row.querySelector('.material').value,
                    sizeW:              row.querySelector('input.sizeW').value,
                    sizeH:              row.querySelector('input.sizeH').value,
                    sizeUnit:           row.querySelector('input.sizeUnit').value,
                    multipliers,
                    addons,
                    isManual,
                    manualFormula:      isManual && formulaInp ? formulaInp.value : '',
                    computedUnitPrice:  row.querySelector('input.price').value,
                    qty:                row.querySelector('input.qty').value
                });
            });

            // Capture flat rate items
            const flatRateItems = [];
            document.querySelectorAll('#flatRateItems .flat-item-row').forEach(row => {
                flatRateItems.push({
                    material:  row.querySelector('.material').value,
                    flatPrice: row.querySelector('input.flatPrice').value,
                    qty:       row.querySelector('input.qty').value,
                    computedUnitPrice: row.querySelector('input.flatPrice').value
                });
            });

            // Capture outsource items
            const outsourceItems = [];
            document.querySelectorAll('#outsourceItems .item-wrapper').forEach(wrapper => {
                const row = wrapper.querySelector('.item-row');
                const mults = [];
                wrapper.querySelectorAll('.outMultVal').forEach(inp => mults.push(parseFloat(inp.value) || 1));
                outsourceItems.push({
                    material:   row.querySelector('.material').value,
                    sizeW:      row.querySelector('input.sizeW').value,
                    sizeH:      row.querySelector('input.sizeH').value,
                    sizeUnit:   row.querySelector('input.sizeUnit').value,
                    basePrice:  wrapper.querySelector('input.outsourceBase').value,
                    multipliers: mults,
                    computedUnitPrice: row.querySelector('input.price').value,
                    qty:        row.querySelector('input.qty').value
                });
            });

            return {
                controlNumber: currentControlNumber,
                revisions:     currentRevision,
                createdAt:     new Date().toISOString(),
                lastSaved:     new Date().toISOString(),
                company:       document.getElementById('company').value,
                address:       document.getElementById('address').value,
                tin:           document.getElementById('tin').value,
                attentionTo:   document.getElementById('attentionTo').value,
                date:          document.getElementById('date').value,
                tel:           document.getElementById('tel').value,
                leadTime:      document.getElementById('leadTime').value,
                projectName:   document.getElementById('projectName').value,
                paymentTerms:  (function() { const s = document.getElementById('paymentTerms'); return s.value === 'others' ? document.getElementById('otherPaymentTerms').value : s.value; })(),
                salesName:     document.getElementById('salesName').value,
                salesContact:  document.getElementById('salesContact').value,
                salesEmail:    document.getElementById('salesEmail').value,
                salesPosition: document.getElementById('salesPosition').value,
                bankDetails:   document.getElementById('bankDetailsSelect')?.value || '',
                items,
                outsourceItems,
                flatRateItems
            };
        }

        /* ── Loaded-mode: swap buttons when editing a saved quote ── */
        function setLoadedMode() {
            const btnGen = document.getElementById('btnGenerateQuote');
            const btnOvr = document.getElementById('btnOverwrite');
            const btnRev = document.getElementById('btnRevision');
            if (btnGen) btnGen.style.display = 'none';
            if (btnOvr) btnOvr.style.display = '';
            if (btnRev) btnRev.style.display = '';
        }
        function resetLoadedMode() {
            const btnGen = document.getElementById('btnGenerateQuote');
            const btnOvr = document.getElementById('btnOverwrite');
            const btnRev = document.getElementById('btnRevision');
            if (btnGen) btnGen.style.display = '';
            if (btnOvr) btnOvr.style.display = 'none';
            if (btnRev) btnRev.style.display = 'none';
        }

        async function overwriteQuote() {
            if (!_loadedStoreKey) { alert('No loaded quote to overwrite.'); return; }
            if (!confirm('Overwrite this quote? The existing data will be replaced.')) return;
            document.getElementById('loading').classList.add('show');
            try { await _submitQuote({ forceStoreKey: _loadedStoreKey, forceRevision: currentRevision }); }
            finally { document.getElementById('loading').classList.remove('show'); }
        }

        async function generateRevision() {
            if (!_loadedStoreKey) { alert('No loaded quote to revise.'); return; }
            document.getElementById('loading').classList.add('show');
            try {
                const db = await loadDB(true);
                const parts = _loadedStoreKey.split('|');
                const baseKey = parts[0] + '|' + parts[1];
                const existingRevs = Object.keys(db).filter(k => k.startsWith(baseKey + '|rev'));
                const maxRev = existingRevs.length > 0
                    ? Math.max(...existingRevs.map(k => { const m = k.match(/\|rev(\d+)$/); return m ? parseInt(m[1]) : 0; }))
                    : currentRevision;
                const newRev = maxRev + 1;
                const newStoreKey = baseKey + '|rev' + newRev;
                await _submitQuote({ forceStoreKey: newStoreKey, forceRevision: newRev });
                currentRevision = newRev;
                _loadedStoreKey = newStoreKey;
                refreshCtrlDisplay();
            } finally { document.getElementById('loading').classList.remove('show'); }
        }

        function restoreSnapshot(snap) {
            _loadedFromSnapshot = true;
            currentControlNumber = snap.controlNumber;
            currentRevision      = snap.revisions || 0;

            document.getElementById('company').value     = snap.company     || '';
            document.getElementById('address').value     = snap.address     || '';
            document.getElementById('tin').value         = snap.tin         || '';
            document.getElementById('attentionTo').value = snap.attentionTo || '';
            document.getElementById('date').value        = snap.date        || '';
            document.getElementById('tel').value         = snap.tel         || '';
            document.getElementById('leadTime').value    = snap.leadTime    || '7';
            document.getElementById('projectName').value = snap.projectName || '';
            // Restore payment terms
            const ptSel = document.getElementById('paymentTerms');
            const ptOpts = Array.from(ptSel.options).map(o => o.value);
            if (snap.paymentTerms && ptOpts.includes(snap.paymentTerms)) {
                ptSel.value = snap.paymentTerms;
            } else if (snap.paymentTerms) {
                ptSel.value = 'others';
                document.getElementById('otherPaymentTerms').value = snap.paymentTerms;
            }
            toggleOtherPayment();
            // Restore sales personnel
            document.getElementById('salesName').value     = snap.salesName     || '';
            document.getElementById('salesContact').value  = snap.salesContact  || '';
            document.getElementById('salesEmail').value    = snap.salesEmail    || '';
            document.getElementById('salesPosition').value = snap.salesPosition || '';
            const bankSel = document.getElementById('bankDetailsSelect');
            if (bankSel && snap.bankDetails) {
                bankSel.value = snap.bankDetails;
                // Restore checkboxes
                const saved = snap.bankDetails.split(',');
                document.querySelectorAll('.bank-chk').forEach(chk => {
                    chk.checked = saved.includes(chk.value);
                });
                if (typeof updateBankLabel === 'function') updateBankLabel();
            }

            // Rebuild items
            document.getElementById('items').innerHTML = '';
            itemCount = 0;
            Object.keys(multCounters).forEach(k => delete multCounters[k]);
            Object.keys(addonCounters).forEach(k => delete addonCounters[k]);

            snap.items.forEach(saved => {
                // Legacy: old flat fee items migrate to the flat rate section
                if (saved.flatFee) {
                    addFlatRateItem();
                    const fr = document.getElementById('flatRate' + flatRateCount);
                    if (fr) {
                        fr.querySelector('.material').value  = saved.material || '';
                        fr.querySelector('input.flatPrice').value = saved.flatPrice || saved.computedUnitPrice || 0;
                        fr.querySelector('input.qty').value       = saved.qty || 1;
                    }
                    return; // don't add to in-house section
                }

                addItem();  // creates a fresh row with itemCount id
                const id      = itemCount;
                const wrapper = document.getElementById('item' + id);
                const row     = wrapper.querySelector('.item-row');

                row.querySelector('.material').value  = saved.material  || '';
                row.querySelector('input.sizeUnit').value  = saved.sizeUnit  || '';
                row.querySelector('input.qty').value       = saved.qty       || 1;
                row.querySelector('input.sizeW').value     = saved.sizeW     || '';
                row.querySelector('input.sizeH').value     = saved.sizeH     || '';

                // Restore manual formula if it was active
                if (saved.isManual && saved.manualFormula) {
                    const btn = document.getElementById('btnManual' + id);
                    const formulaRow = document.getElementById('manualFormulaRow' + id);
                    const formulaInput = document.getElementById('manualFormula' + id);
                    if (btn) btn.classList.add('active');
                    if (formulaRow) formulaRow.classList.add('active');
                    if (formulaInput) formulaInput.value = saved.manualFormula;
                }

                (saved.multipliers || []).forEach(v => {
                    addMultiplier(id);
                    const mNum = multCounters[id];
                    document.getElementById(`mult_${id}_${mNum}`).querySelector('.multVal').value = v;
                });

                (saved.addons || []).forEach(a => {
                    addAddon(id);
                    const aNum = addonCounters[id];
                    const tag  = document.getElementById(`addon_${id}_${aNum}`);
                    tag.querySelector('.addon-desc').value  = a.desc  || '';
                    tag.querySelector('.addon-price').value = a.price || 0;
                    tag.querySelector('.addon-qty').value   = a.qty   || 1;
                });
            });

            // Rebuild outsource items
            document.getElementById('outsourceItems').innerHTML = '';
            outsourceCount = 0;
            Object.keys(outMultCounters).forEach(k => delete outMultCounters[k]);

            (snap.outsourceItems || []).forEach(saved => {
                addOutsourceItem();
                const id      = outsourceCount;
                const wrapper = document.getElementById('outsource' + id);
                const row     = wrapper.querySelector('.item-row');

                row.querySelector('.material').value  = saved.material || '';
                row.querySelector('input.sizeW').value     = saved.sizeW    || '';
                row.querySelector('input.sizeH').value     = saved.sizeH    || '';
                row.querySelector('input.sizeUnit').value  = saved.sizeUnit || '';
                row.querySelector('input.qty').value       = saved.qty      || 1;
                wrapper.querySelector('input.outsourceBase').value = saved.basePrice || '';

                (saved.multipliers || []).forEach(v => {
                    addOutsourceMult(id);
                    const mNum = outMultCounters[id];
                    document.getElementById(`outMult_${id}_${mNum}`).querySelector('.outMultVal').value = v;
                });
            });

            // Rebuild flat rate items
            restoreFlatRateItems(snap.flatRateItems);
            calculateTotals();
            refreshCtrlDisplay();
            setLoadedMode();
            // Auto-resize all material textareas after restore
            document.querySelectorAll('.material').forEach(el => {
                if (el.tagName === 'TEXTAREA') autoResizeTextarea(el);
            });
        }
        function restoreFlatRateItems(snapItems) {
            document.getElementById('flatRateItems').innerHTML = '';
            flatRateCount = 0;
            (snapItems || []).forEach(saved => {
                addFlatRateItem();
                const row = document.getElementById('flatRate' + flatRateCount);
                if (row) {
                    row.querySelector('.material').value  = saved.material  || '';
                    row.querySelector('input.flatPrice').value = saved.flatPrice || saved.computedUnitPrice || 0;
                    row.querySelector('input.qty').value       = saved.qty       || 1;
                }
            });
            calculateTotals();
        }

        /* ── Save quote to server (Google Drive) ── */
        async function persistQuote(revision) {
            const snap = captureSnapshot();
            snap.revisions = revision;
            snap.lastSaved = new Date().toISOString();
            // Each revision gets its own key — nothing is ever overwritten
            const storeKey = currentControlNumber + '|' + companyKey(snap.company) + '|rev' + revision;
            await saveQuote(storeKey, snap);
        }

        /* ── Section Clear Functions ── */
        function clearClientInfo() {
            if (!confirm('Clear all Client Information fields?')) return;
            ['company','address','tel','tin','attentionTo','projectName'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = '';
            });
            document.getElementById('leadTime').value = '7';
            document.getElementById('date').valueAsDate = new Date();
            document.getElementById('paymentTerms').value = 'COD for first time customers';
            document.getElementById('otherPaymentTerms').value = '';
            document.getElementById('otherPaymentGroup').style.display = 'none';
            initControlNumber(); // reset control number preview for blank company
        }

        function clearInHouseItems() {
            if (!confirm('Remove all In-House items?')) return;
            document.getElementById('items').innerHTML = '';
            itemCount = 0;
            Object.keys(multCounters).forEach(k => delete multCounters[k]);
            Object.keys(addonCounters).forEach(k => delete addonCounters[k]);
            calculateTotals();
        }

        function clearOutsourceItems() {
            if (!confirm('Remove all Outsource items?')) return;
            document.getElementById('outsourceItems').innerHTML = '';
            outsourceCount = 0;
            Object.keys(outMultCounters).forEach(k => delete outMultCounters[k]);
            calculateTotals();
        }

        function clearFlatRateItems() {
            if (!confirm('Remove all Flat Rate items?')) return;
            document.getElementById('flatRateItems').innerHTML = '';
            flatRateCount = 0;
            calculateTotals();
        }

        /* ── History modal ── */
        async function openHistory() {
            document.getElementById('historyModal').classList.add('open');
            document.getElementById('historyList').innerHTML = '<div class="history-empty">Loading...</div>';
            // Show select-to-delete footer only in dev mode
            const footer = document.getElementById('historyFooter');
            if (footer) footer.className = 'modal-footer' + (isDevMode() ? ' dev-visible' : '');
            await loadDB(true); // force refresh from server
            renderHistory();
        }
        function closeHistory() {
            document.getElementById('historyModal').classList.remove('open');
            const s = document.getElementById('historySearch');
            if (s) s.value = '';
        }
        // Close on overlay click
        document.getElementById('historyModal').addEventListener('click', function(e) {
            if (e.target === this) closeHistory();
        });

        function renderHistory() {
            const db    = _cachedDb || {};
            const list  = document.getElementById('historyList');
            const countEl = document.getElementById('historyCount');
            const query = (document.getElementById('historySearch')?.value || '').trim().toLowerCase();
            const devMode = isDevMode();

            let keys = Object.keys(db);

            if (keys.length === 0) {
                list.innerHTML = '<div class="history-empty">No saved quotes yet.</div>';
                if (countEl) countEl.textContent = '';
                return;
            }

            // Filter by current sales rep.
            // In dev mode: show all ONLY if the __dev__ pseudo-profile is active.
            // If a real rep profile is selected in the dev switcher, filter to their quotes.
            // In normal mode: always filter to the logged-in rep.
            const isAllDevView = devMode && _currentProfile && _currentProfile.id === '__dev__';
            if (!isAllDevView && _currentProfile && _currentProfile.name) {
                const myName = _currentProfile.name.trim().toLowerCase();
                keys = keys.filter(k => (db[k].salesName || '').trim().toLowerCase() === myName);
            }

            // ── Group by company name (folder), then by controlNumber|companyKey (quote group) ──
            // storeKey format: Q26_XXXX|companykey|revN
            const byCompany = {}; // companyName → { baseKey → [storeKeys] }
            keys.forEach(k => {
                const snap = db[k];
                const companyName = (snap.company || '(No Company)').trim();
                const parts   = k.split('|');
                const baseKey = parts[0] + '|' + (parts[1] || '');
                if (!byCompany[companyName]) byCompany[companyName] = {};
                if (!byCompany[companyName][baseKey]) byCompany[companyName][baseKey] = [];
                byCompany[companyName][baseKey].push(k);
            });

            // Sort revisions within each quote group (highest first)
            Object.values(byCompany).forEach(quoteGroups => {
                Object.values(quoteGroups).forEach(arr => {
                    arr.sort((a, b) => {
                        const ra = parseInt((a.match(/\|rev(\d+)$/) || [,0])[1]);
                        const rb = parseInt((b.match(/\|rev(\d+)$/) || [,0])[1]);
                        return rb - ra;
                    });
                });
            });

            // Sort quote groups within each company folder by latest saved (newest first)
            const sortedQuoteGroups = (quoteGroups) => {
                return Object.keys(quoteGroups).sort((a, b) => {
                    const la = db[quoteGroups[a][0]]?.lastSaved || '';
                    const lb = db[quoteGroups[b][0]]?.lastSaved || '';
                    return new Date(lb) - new Date(la);
                });
            };

            // Sort companies by their most-recently-modified quote
            let companyNames = Object.keys(byCompany).sort((a, b) => {
                const latestA = sortedQuoteGroups(byCompany[a])[0];
                const latestB = sortedQuoteGroups(byCompany[b])[0];
                const la = latestA ? db[byCompany[a][latestA][0]]?.lastSaved || '' : '';
                const lb = latestB ? db[byCompany[b][latestB][0]]?.lastSaved || '' : '';
                return new Date(lb) - new Date(la);
            });

            const totalQuoteGroups = companyNames.reduce((n, c) => n + Object.keys(byCompany[c]).length, 0);

            // Apply search filter across companies
            if (query) {
                companyNames = companyNames.filter(c => {
                    if (c.toLowerCase().includes(query)) return true;
                    return Object.values(byCompany[c]).some(revs =>
                        revs.some(k => {
                            const s = db[k];
                            const hay = [s.controlNumber || '', s.company || '', s.projectName || ''].join(' ').toLowerCase();
                            return hay.includes(query);
                        })
                    );
                });
            }

            if (countEl) {
                countEl.textContent = query
                    ? `${companyNames.length} of ${Object.keys(byCompany).length} compan${Object.keys(byCompany).length !== 1 ? 'ies' : 'y'} match`
                    : `${totalQuoteGroups} quote${totalQuoteGroups !== 1 ? 's' : ''} · ${Object.keys(byCompany).length} compan${Object.keys(byCompany).length !== 1 ? 'ies' : 'y'}`;
            }

            if (companyNames.length === 0) {
                list.innerHTML = `<div class="history-empty">No quotes match "<strong>${query}</strong>".</div>`;
                return;
            }

            const hl = (text) => {
                if (!query || !text) return text || '';
                const idx = text.toLowerCase().indexOf(query);
                if (idx === -1) return text;
                return text.slice(0, idx)
                    + `<mark style="background:#fff3b0;border-radius:2px;padding:0 1px;">${text.slice(idx, idx + query.length)}</mark>`
                    + text.slice(idx + query.length);
            };

            list.innerHTML = companyNames.map(companyName => {
                const quoteGroups = byCompany[companyName];
                const groupKeys   = sortedQuoteGroups(quoteGroups);
                const totalRevs   = groupKeys.length;

                // Grab latest snapshot for this company (for "New Quote" pre-fill)
                const newestGroupKey = groupKeys[0];
                const newestSnap     = db[quoteGroups[newestGroupKey][0]];
                const lastModified   = new Date(newestSnap?.lastSaved).toLocaleString('en-PH', { dateStyle:'medium', timeStyle:'short' });
                const safeCompany    = companyName.replace(/'/g, "\\'");

                // Build quote rows inside folder
                const quoteRows = groupKeys.map(gk => {
                    const revKeys      = quoteGroups[gk];
                    const latestKey    = revKeys[0];
                    const latest       = db[latestKey];
                    const hasRevs      = revKeys.length > 1;
                    const latestRevNum = latest.revisions || 0;
                    const latestLabel  = latestRevNum > 0 ? `Rev${latestRevNum}` : 'Original';
                    const safeLatest   = latestKey.replace(/'/g, "\\'");
                    const saved = new Date(latest.lastSaved).toLocaleString('en-PH', { dateStyle:'medium', timeStyle:'short' });
                    const salesPerson  = latest.salesName
                        ? `<span style="color:#27ae60;font-size:11px;">${latest.salesName}${latest.salesPosition ? ' · ' + latest.salesPosition : ''}</span>`
                        : '';

                    // Delete button — visible to all users for their own quotes
                    const deleteBtn = `<button class="btn-delete-hist" title="Delete this quote" onclick="event.stopPropagation();deleteQuote(event,'${safeLatest}')">🗑</button>`;

                    // Dev checkboxes
                    const checkboxHtml = devMode
                        ? `<input type="checkbox" class="history-checkbox" data-key="${safeLatest}"
                            onclick="event.stopPropagation(); updateDeleteCount();">`
                        : '';

                    // Revision dropdown rows
                    const revDropdownItems = hasRevs ? revKeys.slice(1).map(rk => {
                        const rs     = db[rk];
                        const rvNum  = rs.revisions || 0;
                        const rvLabel = rvNum > 0 ? `Rev${rvNum}` : 'Original';
                        const rvSaved = new Date(rs.lastSaved).toLocaleString('en-PH', { dateStyle:'medium', timeStyle:'short' });
                        const safeRk  = rk.replace(/'/g, "\\'");
                        const devCb   = devMode
                            ? `<input type="checkbox" class="history-checkbox" data-key="${safeRk}"
                                onclick="event.stopPropagation(); updateDeleteCount();" style="margin-right:4px;">`
                            : '';
                        return `
                          <div class="history-rev-row" onclick="loadQuote('${safeRk}')" title="Load ${rvLabel}">
                            ${devCb}
                            <span class="history-rev-label ${rvNum === 0 ? 'rev-original' : ''}">${rvLabel}</span>
                            <span class="history-rev-date">Saved: ${rvSaved}</span>
                            <button class="btn-delete-hist" title="Delete" onclick="event.stopPropagation();deleteQuote(event,'${safeRk}')">🗑</button>
                          </div>`;
                    }).join('') : '';

                    const dropdownToggle = hasRevs
                        ? `<button class="btn-rev-toggle" title="Show all revisions"
                              onclick="event.stopPropagation(); toggleRevDropdown(this)">▾</button>`
                        : '';

                    return `
                      <div class="history-item">
                        <div class="history-item-top" onclick="loadQuote('${safeLatest}')" style="cursor:pointer;" title="Click to load this quote">
                          ${checkboxHtml}
                          <span class="history-ctrl">${hl(latest.controlNumber || latestKey)}</span>
                          <div class="history-info">
                            <div class="history-meta">
                              ${latest.projectName ? `<span style="color:#7f5af0;font-size:11px;">${hl(latest.projectName)}</span> · ` : ''}${salesPerson ? salesPerson + ' · ' : ''}Saved: ${saved}
                            </div>
                          </div>
                          <span class="history-rev ${latestRevNum > 0 ? '' : 'rev-original-badge'}">${latestLabel}</span>
                          ${dropdownToggle}
                          ${deleteBtn}
                        </div>
                        ${hasRevs ? `<div class="history-rev-dropdown">${revDropdownItems}</div>` : ''}
                      </div>`;
                }).join('');

                return `
                  <div class="company-folder" id="folder-${btoa(companyName).replace(/[^a-zA-Z0-9]/g,'')}">
                    <div class="company-folder-header" onclick="toggleFolder(this)">
                      <span class="folder-company-name">${hl(companyName)}</span>
                      <span class="folder-meta">Last modified: ${lastModified}</span>
                      <span class="folder-quote-count">${totalRevs} quote${totalRevs !== 1 ? 's' : ''}</span>
                      <span class="folder-chevron">▶</span>
                    </div>
                    <div class="company-folder-body">
                      <button class="btn-new-for-company" onclick="newQuoteForCompany('${safeCompany}')">
                        New quote for ${companyName}
                      </button>
                      ${quoteRows}
                    </div>
                  </div>`;
            }).join('');
        }

        function toggleFolder(header) {
            header.classList.toggle('open');
            header.nextElementSibling.classList.toggle('open');
        }

        function toggleRevDropdown(btn) {
            const item = btn.closest('.history-item');
            const dropdown = item.querySelector('.history-rev-dropdown');
            if (!dropdown) return;
            const isOpen = dropdown.classList.toggle('open');
            btn.textContent = isOpen ? '▴' : '▾';
        }

        /* Pre-fill company info from the most recent quote for that company, then close modal */
        async function newQuoteForCompany(companyName) {
            const db = _cachedDb || {};
            // Find the most recently saved quote for this company
            const matchingKeys = Object.keys(db).filter(k =>
                (db[k].company || '').trim().toLowerCase() === companyName.trim().toLowerCase()
            );
            if (!matchingKeys.length) { closeHistory(); return; }

            // Pick the most recently saved
            matchingKeys.sort((a, b) => new Date(db[b].lastSaved) - new Date(db[a].lastSaved));
            const snap = db[matchingKeys[0]];

            // Reset form fully first (new quote — no loaded key, fresh serial)
            _loadedStoreKey     = null;
            _loadedFromSnapshot = false;
            currentRevision     = 0;

            // Pre-fill company fields only
            document.getElementById('company').value     = snap.company     || '';
            document.getElementById('address').value     = snap.address     || '';
            document.getElementById('tin').value         = snap.tin         || '';
            document.getElementById('tel').value         = snap.tel         || '';
            const ptSel  = document.getElementById('paymentTerms');
            const ptOpts = Array.from(ptSel.options).map(o => o.value);
            if (snap.paymentTerms && ptOpts.includes(snap.paymentTerms)) {
                ptSel.value = snap.paymentTerms;
            } else if (snap.paymentTerms) {
                ptSel.value = 'others';
                document.getElementById('otherPaymentTerms').value = snap.paymentTerms;
            }
            toggleOtherPayment();

            // Clear project-specific fields
            document.getElementById('attentionTo').value = '';
            document.getElementById('projectName').value = '';
            document.getElementById('leadTime').value    = '7';
            document.getElementById('date').valueAsDate  = new Date();

            // Clear items
            document.getElementById('items').innerHTML = '';
            document.getElementById('outsourceItems').innerHTML = '';
            itemCount = 0; outsourceCount = 0;
            Object.keys(multCounters).forEach(k => delete multCounters[k]);
            Object.keys(addonCounters).forEach(k => delete addonCounters[k]);
            Object.keys(outMultCounters).forEach(k => delete outMultCounters[k]);

            // Get a fresh serial for this company
            const serial = await peekNextSerial(snap.company || '');
            currentControlNumber = buildControlNumber(serial);
            calculateTotals();
            refreshCtrlDisplay();
            closeHistory();
        }

        function loadQuote(storeKey) {
            const db   = _cachedDb || {};
            const snap = db[storeKey];
            if (!snap) return;
            _loadedStoreKey = storeKey;   // remember which saved quote we opened
            restoreSnapshot(snap);
            closeHistory();
        }

        /* ── Build the /api/generate-quotation payload straight from a saved snapshot ── */
        function snapshotToApiPayload(snap) {
            return {
                controlNumber:  snap.controlNumber,
                revisionNumber: snap.revisions || 0,
                company:        snap.company       || '',
                address:        snap.address       || '',
                tin:            snap.tin           || '',
                attentionTo:    snap.attentionTo   || '',
                date:           snap.date          || '',
                tel:            snap.tel           || '',
                leadTime:       snap.leadTime       || '',
                projectName:    snap.projectName   || '',
                paymentTerms:   snap.paymentTerms   || '',
                salesName:      snap.salesName      || '',
                salesContact:   snap.salesContact   || '',
                salesEmail:     snap.salesEmail     || '',
                salesPosition:  snap.salesPosition  || '',
                items: (snap.items || []).map(it => ({
                    material:  it.material  || '',
                    sizeW:     it.sizeW || '',
                    sizeH:     it.sizeH || '',
                    sizeUnit:  it.sizeUnit  || '',
                    unitPrice: String(it.computedUnitPrice || 0).replace(/,/g, ''),
                    quantity:  it.qty || 0
                })),
                outsourceItems: (snap.outsourceItems || []).map(it => ({
                    material:    it.material  || '',
                    sizeW:       it.sizeW     || '',
                    sizeH:       it.sizeH     || '',
                    sizeUnit:    it.sizeUnit  || '',
                    basePrice:   parseFloat(it.basePrice) || 0,
                    multipliers: it.multipliers || [],
                    unitPrice:   String(it.computedUnitPrice || 0).replace(/,/g, ''),
                    quantity:    it.qty || 0
                })),
                flatRateItems: (snap.flatRateItems || []).map(it => ({
                    material:  it.material || '',
                    unitPrice: String(it.flatPrice || it.computedUnitPrice || 0).replace(/,/g, ''),
                    quantity:  it.qty || 0
                }))
            };
        }

        /* ── Preview PDF for a saved quote, without touching its revision/serial ── */
        async function previewQuote(storeKey, e) {
            if (e) e.stopPropagation();
            const db   = _cachedDb || {};
            const snap = db[storeKey];
            if (!snap) return;

            document.getElementById('loading').classList.add('show');
            try {
                const data = snapshotToApiPayload(snap);
                const response = await fetch(`${API}/api/generate-quotation`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });

                if (!response.ok) {
                    const errText = await response.text().catch(() => '');
                    throw new Error(errText || 'Failed to generate PDF preview');
                }

                const disposition = response.headers.get('Content-Disposition') || '';
                const match = disposition.match(/filename="([^"]+)"/);
                const filename = match ? match[1] : `${data.controlNumber}_${data.company}.pdf`;

                const blob = await response.blob();
                const namedFile = new File([blob], filename, { type: 'application/pdf' });
                const url = window.URL.createObjectURL(namedFile);
                window.open(url, '_blank');
                setTimeout(() => window.URL.revokeObjectURL(url), 30000);
            } catch (err) {
                alert(err.message);
            } finally {
                document.getElementById('loading').classList.remove('show');
            }
        }

        async function deleteQuote(e, storeKey) {
            e.stopPropagation();
            const db   = _cachedDb || {};
            const snap = db[storeKey];
            const label = snap ? `${snap.controlNumber} - ${snap.company}` : storeKey;
            if (!confirm(`Delete quote "${label}"? This cannot be undone.`)) return;
            await deleteQuoteFromServer(storeKey);
            await syncSerialsAfterDelete();
            const companyVal = document.getElementById('company').value;
            if (companyVal) {
                const serial = await peekNextSerial(companyVal);
                currentControlNumber = buildControlNumber(serial);
                currentRevision = 0;
                refreshCtrlDisplay();
            }
            renderHistory();
        }

        /* ═══════════════════════════════════════════════════════
           ITEM BUILDER
        ═══════════════════════════════════════════════════════ */
        let itemCount = 0;
        const multCounters  = {};
        const addonCounters = {};

        document.getElementById('date').valueAsDate = new Date();

        document.getElementById('items').addEventListener('input', function(e) {
            if (
                e.target.classList.contains('sizeW') ||
                e.target.classList.contains('sizeH') ||
                e.target.classList.contains('qty') ||
                e.target.classList.contains('multVal') ||
                e.target.classList.contains('addon-price') ||
                e.target.classList.contains('addon-qty') ||
                e.target.classList.contains('manual-formula-input')
            ) { calculateTotals(); }
        });


        document.getElementById('outsourceItems').addEventListener('input', function(e) {
            if (
                e.target.classList.contains('sizeW') ||
                e.target.classList.contains('sizeH') ||
                e.target.classList.contains('qty') ||
                e.target.classList.contains('outsourceBase') ||
                e.target.classList.contains('outMultVal')
            ) { calculateTotals(); }
        });

        initControlNumber();

        function addItem() {
            itemCount++;
            const id = itemCount;

            const wrapper = document.createElement('div');
            wrapper.className = 'item-wrapper';
            wrapper.id = 'item' + id;

            const row = document.createElement('div');
            row.className = 'item-row';
            row.innerHTML = `
                <textarea placeholder="Description" class="material" rows="1" style="resize:none;overflow:hidden;"></textarea>
                <div class="size-cell">
                    <div class="size-split">
                        <input type="number" step="any" min="0" placeholder="W" class="sizeW">
                        <span>×</span>
                        <input type="number" step="any" min="0" placeholder="H" class="sizeH">
                    </div>
                </div>
                <input type="text" placeholder="ft" class="sizeUnit" style="text-align:center;">
                <input type="text" class="price" readonly placeholder="0.00" style="text-align:right;background:#f0f4ff;color:#2c3e50;font-weight:bold;border:1px solid #c5d5f0;cursor:default;">
                <input type="number" min="1" value="1" class="qty" style="text-align:center;">
                <input type="text" class="rowTotalAmount" readonly value="0.00" style="background:#f8f9fa;font-weight:bold;border:1px solid #ccd1d1;text-align:right;">
                <button type="button" class="btn-remove" onclick="removeItem(${id})">✕</button>
            `;

            const multRow = document.createElement('div');
            multRow.className = 'multiplier-row';
            multRow.innerHTML = `
                <div class="size-dependent" id="sizeDependent${id}">
                    <div class="multiplier-tags" id="multTags${id}"></div>
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                        <button type="button" class="btn-add-mult" onclick="addMultiplier(${id})">+ Add Multiplier</button>
                        <button type="button" class="btn-toggle-manual" id="btnManual${id}" onclick="toggleManualFormula(${id})">f(x) Manual Formula</button>
                    </div>
                    <div class="mult-summary" id="multFormula${id}">W x H = Unit Price (add multipliers to add more terms)</div>
                    <div class="manual-formula-row" id="manualFormulaRow${id}">
                        <span class="manual-formula-label">= </span>
                        <input type="text" class="manual-formula-input" id="manualFormula${id}"
                            placeholder="e.g. W*H*250 or W*H*120 + W*H*80"
                            oninput="calculateTotals()" autocomplete="off" spellcheck="false">
                        <span class="manual-formula-result" id="manualFormulaResult${id}">—</span>
                    </div>
                </div>
                <div class="addon-section">
                    <div class="addon-section-title">Add-on Materials <span style="font-weight:normal;color:#999;">(added to Unit Price, hidden in PDF)</span></div>
                    <div class="addon-tags" id="addonTags${id}"></div>
                    <button type="button" class="btn-add-addon" onclick="addAddon(${id})">+ Add-on Material</button>
                    <div class="addon-total-hint" id="addonHint${id}"></div>
                </div>
            `;

            wrapper.appendChild(row);
            wrapper.appendChild(multRow);
            document.getElementById('items').appendChild(wrapper);
            calculateTotals();
        }

        function addMultiplier(itemId) {
            if (!multCounters[itemId]) multCounters[itemId] = 0;
            multCounters[itemId]++;
            const mNum = multCounters[itemId];
            const container = document.getElementById('multTags' + itemId);
            const tag = document.createElement('div');
            tag.className = 'multiplier-tag';
            tag.id = `mult_${itemId}_${mNum}`;
            tag.innerHTML = `
                <label>×${mNum}</label>
                <input type="number" step="any" min="0" value="1" class="multVal" oninput="calculateTotals()">
                <button type="button" class="remove-mult" onclick="removeMultiplier(${itemId}, ${mNum})" title="Remove">×</button>
            `;
            container.appendChild(tag);
            calculateTotals();
        }

        function removeMultiplier(itemId, mNum) {
            const tag = document.getElementById(`mult_${itemId}_${mNum}`);
            if (tag) tag.remove();
            const container = document.getElementById('multTags' + itemId);
            container.querySelectorAll('.multiplier-tag').forEach((t, i) => {
                t.querySelector('label').textContent = '×' + (i + 1);
            });
            calculateTotals();
        }

        function addAddon(itemId) {
            if (!addonCounters[itemId]) addonCounters[itemId] = 0;
            addonCounters[itemId]++;
            const aNum = addonCounters[itemId];
            const container = document.getElementById('addonTags' + itemId);
            const tag = document.createElement('div');
            tag.className = 'addon-tag';
            tag.id = `addon_${itemId}_${aNum}`;
            tag.innerHTML = `
                <span class="addon-label">#${aNum}</span>
                <input type="text" class="addon-desc" placeholder="e.g. Bolts" oninput="calculateTotals()">
                <span class="addon-label">Price</span>
                <input type="number" step="0.01" min="0" value="0" class="addon-price" oninput="calculateTotals()">
                <span class="addon-label">× Qty</span>
                <input type="number" min="1" value="1" class="addon-qty" oninput="calculateTotals()">
                <span class="addon-subtotal" id="addonSub_${itemId}_${aNum}">= 0.00</span>
                <button type="button" class="remove-addon" onclick="removeAddon(${itemId}, ${aNum})" title="Remove">×</button>
            `;
            container.appendChild(tag);
            calculateTotals();
        }

        function removeAddon(itemId, aNum) {
            const tag = document.getElementById(`addon_${itemId}_${aNum}`);
            if (tag) tag.remove();
            const container = document.getElementById('addonTags' + itemId);
            container.querySelectorAll('.addon-tag').forEach((t, i) => {
                t.querySelector('.addon-label').textContent = '#' + (i + 1);
            });
            calculateTotals();
        }

        function removeItem(id) {
            document.getElementById('item' + id).remove();
            calculateTotals();
        }

        function toggleManualFormula(id) {
            const btn = document.getElementById('btnManual' + id);
            const row = document.getElementById('manualFormulaRow' + id);
            const isActive = btn.classList.toggle('active');
            row.classList.toggle('active', isActive);
            // When disabling, clear result label
            if (!isActive) {
                const res = document.getElementById('manualFormulaResult' + id);
                if (res) { res.textContent = '—'; res.className = 'manual-formula-result'; }
            }
            calculateTotals();
        }

        function evalManualFormula(formula, W, H) {
            // Only allow safe characters: numbers, operators, W, H, spaces, parens, dots
            const safe = formula.replace(/\s/g, '');
            if (!/^[0-9WHwh+\-*/().^]+$/.test(safe)) return null;
            try {
                // Replace W and H (case-insensitive) with their numeric values
                const expr = safe
                    .replace(/[Ww]/g, '(' + W + ')')
                    .replace(/[Hh]/g, '(' + H + ')');
                // eslint-disable-next-line no-new-func
                const result = Function('"use strict"; return (' + expr + ')')();
                if (!isFinite(result) || isNaN(result)) return null;
                return result;
            } catch { return null; }
        }



        /* ═══════════════════════════════════════════════════════
           OUTSOURCE ITEM BUILDER
        ═══════════════════════════════════════════════════════ */
        let outsourceCount = 0;
        const outMultCounters = {};

        function addOutsourceItem() {
            outsourceCount++;
            const id = outsourceCount;

            const wrapper = document.createElement('div');
            wrapper.className = 'item-wrapper';
            wrapper.id = 'outsource' + id;

            // Main row (same columns as regular items)
            const row = document.createElement('div');
            row.className = 'item-row';
            row.innerHTML = `
                <textarea placeholder="Description (e.g. Buildup 60×60in)" class="material" rows="1" style="resize:none;overflow:hidden;"></textarea>
                <div class="size-cell">
                    <div class="size-split">
                        <input type="number" step="any" min="0" placeholder="W" class="sizeW">
                        <span>×</span>
                        <input type="number" step="any" min="0" placeholder="H" class="sizeH">
                    </div>
                </div>
                <input type="text" placeholder="in" class="sizeUnit" style="text-align:center;">
                <input type="text" class="price" readonly value="" style="text-align:right;background:#fff8f3;color:#c0392b;font-weight:bold;border:1px solid #f0c09a;cursor:default;">
                <input type="number" min="1" value="1" class="qty" style="text-align:center;">
                <input type="text" class="rowTotalAmount" readonly value="0.00" style="background:#f8f9fa;font-weight:bold;border:1px solid #ccd1d1;text-align:right;">
                <button type="button" class="btn-remove" onclick="removeOutsourceItem(${id})">✕</button>
            `;

            // Controls row: base price + multipliers
            const ctrlRow = document.createElement('div');
            ctrlRow.className = 'multiplier-row';
            ctrlRow.innerHTML = `
                <div class="outsource-base-row">
                    <label><span class="outsource-badge">OUTSOURCE</span> Base Price (from pricelist):</label>
                    <input type="number" step="any" min="0" placeholder="e.g. 500" class="outsourceBase">
                    <span style="font-size:12px;color:#999;">then add multipliers →</span>
                </div>
                <div>
                    <div class="multiplier-tags" id="outMultTags${id}"></div>
                    <button type="button" class="btn-add-outsource-mult" onclick="addOutsourceMult(${id})">× Add Multiplier</button>
                    <div class="outsource-formula" id="outFormula${id}">Base Price = Unit Price</div>
                </div>
            `;

            wrapper.appendChild(row);
            wrapper.appendChild(ctrlRow);
            document.getElementById('outsourceItems').appendChild(wrapper);
            calculateTotals();
        }

        function addOutsourceMult(itemId) {
            if (!outMultCounters[itemId]) outMultCounters[itemId] = 0;
            outMultCounters[itemId]++;
            const mNum = outMultCounters[itemId];
            const container = document.getElementById('outMultTags' + itemId);
            const tag = document.createElement('div');
            tag.className = 'multiplier-tag';
            tag.id = `outMult_${itemId}_${mNum}`;
            tag.innerHTML = `
                <label>×${mNum}</label>
                <input type="number" step="any" min="0" value="1" class="outMultVal" oninput="calculateTotals()">
                <button type="button" class="remove-mult" onclick="removeOutsourceMult(${itemId}, ${mNum})" title="Remove">×</button>
            `;
            container.appendChild(tag);
            calculateTotals();
        }

        function removeOutsourceMult(itemId, mNum) {
            const tag = document.getElementById(`outMult_${itemId}_${mNum}`);
            if (tag) tag.remove();
            document.getElementById('outMultTags' + itemId)
                .querySelectorAll('.multiplier-tag')
                .forEach((t, i) => { t.querySelector('label').textContent = '×' + (i + 1); });
            calculateTotals();
        }

        function removeOutsourceItem(id) {
            document.getElementById('outsource' + id).remove();
            calculateTotals();
        }

        /* ═══════════════════════════════════════════════════════
           FLAT RATE ITEM BUILDER
        ═══════════════════════════════════════════════════════ */
        let flatRateCount = 0;

        document.getElementById('flatRateItems').addEventListener('input', function(e) {
            if (
                e.target.classList.contains('flatPrice') ||
                e.target.classList.contains('qty')
            ) { calculateTotals(); }
        });

        function addFlatRateItem() {
            flatRateCount++;
            const id = flatRateCount;
            const row = document.createElement('div');
            row.className = 'flat-item-row';
            row.id = 'flatRate' + id;
            row.innerHTML = `
                <textarea placeholder="e.g. Installation, Delivery" class="material" rows="1"
                    style="width:100%;min-height:38px;padding:8px 10px;border:1px solid #ddd;border-radius:4px;font-size:14px;resize:none;overflow:hidden;"></textarea>
                <input type="number" step="any" min="0" placeholder="0.00" class="flatPrice"
                    style="width:100%;height:38px;padding:8px 10px;border:1px solid #ddd;border-radius:4px;font-size:14px;text-align:right;">
                <input type="number" min="1" value="1" class="qty"
                    style="width:100%;height:38px;padding:8px 10px;border:1px solid #ddd;border-radius:4px;font-size:14px;text-align:center;">
                <input type="text" class="rowTotalAmount" readonly value="0.00"
                    style="width:100%;height:38px;padding:8px 10px;border:1px solid #ccd1d1;border-radius:4px;font-size:14px;background:#f8f9fa;font-weight:bold;text-align:right;">
                <button type="button" class="btn-remove" onclick="removeFlatRateItem(${id})">✕</button>
            `;
            document.getElementById('flatRateItems').appendChild(row);
            calculateTotals();
        }

        function removeFlatRateItem(id) {
            document.getElementById('flatRate' + id).remove();
            calculateTotals();
        }

        function calculateTotals() {
            let grandTotal = 0;
            document.querySelectorAll('#items .item-wrapper').forEach(wrapper => {
                const row    = wrapper.querySelector('.item-row');
                const qty    = parseFloat(row.querySelector('input.qty').value) || 0;

                let w = 0, h = 0, basePrice = 0;
                const multParts = [];

                w = parseFloat(row.querySelector('input.sizeW').value) || 0;
                h = parseFloat(row.querySelector('input.sizeH').value) || 0;

                // Check if manual formula mode is active
                const manualBtn = wrapper.querySelector('[id^="btnManual"]');
                const isManual  = manualBtn && manualBtn.classList.contains('active');

                    if (isManual) {
                        const formulaInput = wrapper.querySelector('[id^="manualFormula"]:not([id^="manualFormulaR"])');
                        const resultEl     = wrapper.querySelector('[id^="manualFormulaResult"]');
                        const formula      = formulaInput ? formulaInput.value.trim() : '';
                        const result       = formula ? evalManualFormula(formula, w, h) : null;
                        if (result !== null) {
                            basePrice = result;
                            if (resultEl) {
                                resultEl.textContent = '= ' + result.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                                resultEl.className = 'manual-formula-result';
                            }
                        } else {
                            basePrice = 0;
                            if (resultEl) {
                                resultEl.textContent = formula ? 'Invalid' : '—';
                                resultEl.className = 'manual-formula-result' + (formula ? ' err' : '');
                            }
                        }
                    } else {
                        wrapper.querySelectorAll('.multVal').forEach(inp => {
                            multParts.push(parseFloat(inp.value) || 0);
                        });
                        basePrice = multParts.length > 0
                            ? multParts.reduce((sum, v) => sum + (w * h * v), 0)
                            : (w * h);
                    }

                let addonTotal = 0;
                wrapper.querySelectorAll('.addon-tag').forEach(tag => {
                    const ap  = parseFloat(tag.querySelector('.addon-price').value) || 0;
                    const aq  = parseFloat(tag.querySelector('.addon-qty').value)   || 0;
                    const sub = ap * aq;
                    addonTotal += sub;
                    const subEl = tag.querySelector('.addon-subtotal');
                    if (subEl) subEl.textContent = '= ' + sub.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                });

                const unitPrice = basePrice + addonTotal;
                const subtotal  = unitPrice * qty;

                const priceField = row.querySelector('input.price');
                priceField.value = unitPrice > 0
                    ? unitPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                    : '';

                const formulaEl = wrapper.querySelector('[id^="multFormula"]');
                if (formulaEl) {
                    const manualBtn2 = wrapper.querySelector('[id^="btnManual"]');
                    const isManual2  = manualBtn2 && manualBtn2.classList.contains('active');
                    if (isManual2) {
                        const fi = wrapper.querySelector('[id^="manualFormula"]:not([id^="manualFormulaR"])');
                        formulaEl.textContent = fi && fi.value.trim() ? `Formula: ${fi.value.trim()}` : 'Manual formula mode';
                    } else if (multParts.length > 0) {
                        const terms = multParts.map(v => `(${w} x ${h} x ${v})`).join(' + ');
                        formulaEl.textContent = `${terms} = ${basePrice.toFixed(2)}`;
                    } else {
                        formulaEl.textContent = 'W x H = Unit Price (add multipliers to add more terms)';
                    }
                }

                const addonHint = wrapper.querySelector('[id^="addonHint"]');
                if (addonHint) {
                    addonHint.textContent = addonTotal > 0
                        ? `Add-on total: +${addonTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} → Unit Price = ${unitPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : '';
                }

                row.querySelector('.rowTotalAmount').value =
                    subtotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

                grandTotal += subtotal;
            });

            // ── Outsource items ──────────────────────────────────────────
            document.querySelectorAll('#outsourceItems .item-wrapper').forEach(wrapper => {
                const row      = wrapper.querySelector('.item-row');
                const basePrice = parseFloat(wrapper.querySelector('input.outsourceBase').value) || 0;
                const qty      = parseFloat(row.querySelector('input.qty').value) || 0;

                const mults = [];
                wrapper.querySelectorAll('.outMultVal').forEach(inp => mults.push(parseFloat(inp.value) || 1));

                const unitPrice = mults.length > 0
                    ? mults.reduce((acc, m) => acc * m, basePrice)
                    : basePrice;

                const unitPriceRounded = Math.round(unitPrice * 100) / 100;
                const subtotal = unitPriceRounded * qty;

                row.querySelector('input.price').value = unitPriceRounded > 0
                    ? unitPriceRounded.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                    : '';

                const formulaEl = wrapper.querySelector('[id^="outFormula"]');
                if (formulaEl) {
                    if (mults.length > 0) {
                        const chain = [basePrice, ...mults].join(' × ');
                        formulaEl.textContent = `${chain} = ${unitPriceRounded.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                    } else {
                        formulaEl.textContent = 'Base Price = Unit Price';
                    }
                }

                row.querySelector('.rowTotalAmount').value =
                    subtotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

                grandTotal += subtotal;
            });

            // ── Flat rate items ──────────────────────────────────────────
            document.querySelectorAll('#flatRateItems .flat-item-row').forEach(row => {
                const price    = parseFloat(row.querySelector('input.flatPrice').value) || 0;
                const qty      = parseFloat(row.querySelector('input.qty').value) || 0;
                const subtotal = price * qty;
                row.querySelector('.rowTotalAmount').value =
                    subtotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                grandTotal += subtotal;
            });

            document.getElementById('total').textContent =
                '₱ ' + grandTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

            // ── VAT breakdown (12%, extracted from VAT-inclusive price) ──
            const vatChecked = document.getElementById('includeVatCheck')?.checked;
            const vatRow     = document.getElementById('vatBreakdownRow');
            const vatAmt     = document.getElementById('vatAmount');
            const vatBase    = document.getElementById('vatBaseAmount');
            if (vatRow && vatAmt && vatBase) {
                if (vatChecked) {
                    const vat  = grandTotal - (grandTotal / 1.12);
                    const base = grandTotal / 1.12;
                    vatAmt.textContent  = '₱ ' + vat.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                    vatBase.textContent = '₱ ' + base.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                    vatRow.style.display = '';
                } else {
                    vatRow.style.display = 'none';
                }
            }
            // Update Grand Total label based on VAT exclusive toggle
            const vatExChecked = document.getElementById('vatExclusiveCheck')?.checked;
            const gtLabel = document.getElementById('grandTotalLabel');
            if (gtLabel) gtLabel.textContent = vatExChecked ? 'Grand Total (VAT Ex):' : 'Grand Total:';
        }


        async function devResetSerials() {
            if (!confirm('Reset ALL serial counters back to zero?\nNext quote will start from Q26_0001 again.')) return;
            try {
                const r = await fetch(`${API}/api/serials`, { method: 'DELETE' });
                if (r.ok) {
                    await initControlNumber();
                    alert('Serials reset! Next quote will be Q26_0001.');
                } else {
                    alert('Error resetting serials.');
                }
            } catch {
                alert('Server error.');
            }
        }


        /* Block Enter key from submitting — only allow if submit button is focused (via Tab) */
        document.getElementById('form').addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                const active = document.activeElement;
                const isSubmitBtn = active && active.type === 'submit';
                if (!isSubmitBtn) e.preventDefault();
            }
        });

        /* ── Dev: select-to-delete helpers ── */
        function updateDeleteCount() {
            const checked = document.querySelectorAll('.history-checkbox:checked');
            const btn = document.getElementById('btnDeleteSelected');
            const countEl = document.getElementById('deleteSelCount');
            const n = checked.length;
            if (btn) btn.disabled = n === 0;
            if (countEl) countEl.textContent = n > 0 ? `${n} selected` : '';
            const all = document.querySelectorAll('.history-checkbox');
            const selAll = document.getElementById('selectAllCheck');
            if (selAll) selAll.checked = all.length > 0 && checked.length === all.length;
            document.querySelectorAll('.history-item').forEach(item => {
                const cb = item.querySelector('.history-checkbox');
                item.classList.toggle('selected', cb ? cb.checked : false);
            });
        }

        function toggleSelectAll(masterCb) {
            document.querySelectorAll('.history-checkbox').forEach(cb => cb.checked = masterCb.checked);
            updateDeleteCount();
        }

        async function deleteSelected() {
            const checked = Array.from(document.querySelectorAll('.history-checkbox:checked'));
            if (!checked.length) return;
            if (!confirm(`Delete ${checked.length} quote${checked.length > 1 ? 's' : ''}? This cannot be undone.`)) return;
            for (const cb of checked) await deleteQuoteFromServer(cb.dataset.key);
            // Reset serials for any company that now has no quotes left
            await syncSerialsAfterDelete();
            // Also refresh peekNext so the control number display updates
            const companyVal = document.getElementById('company').value;
            if (companyVal) {
                const serial = await peekNextSerial(companyVal);
                currentControlNumber = buildControlNumber(serial);
                currentRevision = 0;
                refreshCtrlDisplay();
            }
            const selAll = document.getElementById('selectAllCheck');
            if (selAll) selAll.checked = false;
            const countEl = document.getElementById('deleteSelCount');
            if (countEl) countEl.textContent = '';
            const btn = document.getElementById('btnDeleteSelected');
            if (btn) btn.disabled = true;
            renderHistory();
        }


        /* ── Ctrl+Enter adds line break in description textareas; auto-resize ── */
        document.getElementById('form').addEventListener('keydown', function(e) {
            if (e.target.classList.contains('material') && e.target.tagName === 'TEXTAREA') {
                if (e.key === 'Enter' && e.ctrlKey) {
                    e.preventDefault();
                    const ta = e.target;
                    const start = ta.selectionStart;
                    const end   = ta.selectionEnd;
                    ta.value = ta.value.slice(0, start) + '\n' + ta.value.slice(end);
                    ta.selectionStart = ta.selectionEnd = start + 1;
                    autoResizeTextarea(ta);
                } else if (e.key === 'Enter' && !e.ctrlKey) {
                    e.preventDefault();
                }
            }
        });

        function autoResizeTextarea(ta) {
            ta.style.height = 'auto';
            ta.style.height = ta.scrollHeight + 'px';
        }

        document.getElementById('form').addEventListener('input', function(e) {
            if (e.target.classList.contains('material') && e.target.tagName === 'TEXTAREA') {
                autoResizeTextarea(e.target);
            }
        });

        document.getElementById('form').addEventListener('submit', async (e) => {
            e.preventDefault();
            document.getElementById('loading').classList.add('show');
            await _submitQuote();
            document.getElementById('loading').classList.remove('show');
        });

        async function _submitQuote(opts = {}) {
            const companyVal = document.getElementById('company').value;

            const bankSel = document.getElementById('bankDetailsSelect');
            if (!bankSel || !bankSel.value) {
                alert('Please select at least one payment detail to include in the PDF.');
                document.getElementById('bankDropdownBtn') && (document.getElementById('bankDropdownBtn').style.borderColor = '#e74c3c');
                return;
            }

            const inHouseCount = document.querySelectorAll('#items .item-wrapper').length;
            if (inHouseCount === 0) {
                const proceed = confirm('No In-House Items added to this quote.\n\nProceed and generate the PDF with Outsource Items only?');
                if (!proceed) return;
            }

            let useStoreKey, useRevision;
            if (opts.forceStoreKey !== undefined) {
                useStoreKey = opts.forceStoreKey;
                useRevision = opts.forceRevision;
                currentRevision = useRevision;
            } else {
                const db = await loadDB(true);
                let baseKey;
                if (_loadedStoreKey) {
                    const parts = _loadedStoreKey.split('|');
                    baseKey = parts[0] + '|' + parts[1];
                } else {
                    baseKey = currentControlNumber + '|' + companyKey(companyVal);
                }
                const existingRevs = Object.keys(db).filter(k => k.startsWith(baseKey + '|rev'));
                if (existingRevs.length > 0) {
                    const maxRev = Math.max(...existingRevs.map(k => { const m = k.match(/\|rev(\d+)$/); return m ? parseInt(m[1]) : 0; }));
                    currentRevision = maxRev + 1;
                } else {
                    const serial = await commitSerial(companyVal);
                    currentControlNumber = buildControlNumber(serial);
                    currentRevision = 0;
                }
                useStoreKey = baseKey + '|rev' + currentRevision;
                useRevision = currentRevision;
                _loadedStoreKey = useStoreKey;
            }

            const snap = captureSnapshot();
            snap.revisions = useRevision;
            snap.lastSaved = new Date().toISOString();
            await saveQuote(useStoreKey, snap);
            refreshCtrlDisplay();

            const data = {
                controlNumber:  currentControlNumber,
                revisionNumber: currentRevision,
                company:    companyVal,
                address:    document.getElementById('address').value,
                tin:        document.getElementById('tin').value,
                attentionTo:document.getElementById('attentionTo').value,
                date:       document.getElementById('date').value,
                tel:        document.getElementById('tel').value,
                leadTime:   document.getElementById('leadTime').value,
                projectName:document.getElementById('projectName').value,
                paymentTerms: (function() { const s = document.getElementById('paymentTerms'); return s.value === 'others' ? document.getElementById('otherPaymentTerms').value : s.value; })(),
                salesName:    document.getElementById('salesName').value,
                salesContact: document.getElementById('salesContact').value,
                salesEmail:   document.getElementById('salesEmail').value,
                salesPosition: document.getElementById('salesPosition').value,
                salesSignature: (_currentProfile && _currentProfile.signature) || null,
                storeKey:     _loadedStoreKey,
                items: [],
                outsourceItems: [],
                flatRateItems: [],
                includeVat: document.getElementById('includeVatCheck')?.checked || false,
                vatExclusive: document.getElementById('vatExclusiveCheck')?.checked || false,
                bankDetails: document.getElementById('bankDetailsSelect')?.value || 'all'
            };

            document.querySelectorAll('#items .item-wrapper').forEach(wrapper => {
                const row    = wrapper.querySelector('.item-row');
                const computedUnitPrice = row.querySelector('input.price').value.replace(/,/g, '') || 0;
                data.items.push({
                    material:  row.querySelector('.material').value,
                    sizeW:     row.querySelector('input.sizeW').value || '',
                    sizeH:     row.querySelector('input.sizeH').value || '',
                    sizeUnit:  row.querySelector('input.sizeUnit').value,
                    unitPrice: computedUnitPrice,
                    quantity:  row.querySelector('input.qty').value || 0
                });
            });

            document.querySelectorAll('#outsourceItems .item-wrapper').forEach(wrapper => {
                const row  = wrapper.querySelector('.item-row');
                const mults = [];
                wrapper.querySelectorAll('.outMultVal').forEach(inp => mults.push(parseFloat(inp.value) || 1));
                const basePrice = parseFloat(wrapper.querySelector('input.outsourceBase').value) || 0;
                const computedUnitPrice = row.querySelector('input.price').value.replace(/,/g, '') || 0;
                data.outsourceItems.push({
                    material:    row.querySelector('.material').value,
                    sizeW:       row.querySelector('input.sizeW').value || '',
                    sizeH:       row.querySelector('input.sizeH').value || '',
                    sizeUnit:    row.querySelector('input.sizeUnit').value,
                    basePrice,
                    multipliers: mults,
                    unitPrice:   computedUnitPrice,
                    quantity:    row.querySelector('input.qty').value || 0
                });
            });

            document.querySelectorAll('#flatRateItems .flat-item-row').forEach(row => {
                const price = row.querySelector('input.flatPrice').value || 0;
                data.flatRateItems.push({
                    material:  row.querySelector('.material').value,
                    unitPrice: String(price).replace(/,/g, ''),
                    quantity:  row.querySelector('input.qty').value || 0
                });
            });

            try {
                const response = await fetch(`${API}/api/generate-quotation`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });

                if (!response.ok) {
                    const errText = await response.text().catch(() => '');
                    throw new Error(errText || 'Failed to generate PDF');
                }

                // Get filename from header
                const disposition = response.headers.get('Content-Disposition') || '';
                const match = disposition.match(/filename="([^"]+)"/);
                const filename = match ? match[1] : `${data.controlNumber}_${data.company}.pdf`;

                const blob = await response.blob();

                // Create a named blob URL so the browser PDF viewer shows the right filename
                // Trick: use a File object instead of raw Blob — it carries the name
                const namedFile = new File([blob], filename, { type: 'application/pdf' });
                const url = window.URL.createObjectURL(namedFile);
                window.open(url, '_blank');

                // Show success notice
                const notice = document.createElement('div');
                notice.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#2ecc71;color:white;padding:14px 20px;border-radius:8px;font-size:14px;font-weight:bold;box-shadow:0 4px 12px rgba(0,0,0,0.2);z-index:9999;max-width:320px;';
                notice.innerHTML = `PDF saved to Drive!<br><span style="font-size:12px;font-weight:normal;opacity:0.9;">${filename}</span>`;
                document.body.appendChild(notice);
                setTimeout(() => notice.remove(), 5000);

                setTimeout(() => window.URL.revokeObjectURL(url), 30000);

            } catch (err) {
                alert(err.message);
            }
        }

        /* ═══════════════════════════════════════════════════════
           DEV TOOLS — only visible with ?dev=1 in the URL.
           Lets you skip manually filling the form and preview a
           PDF without burning a serial number, saving to history,
           or writing a file into the shared Drive folder.
        ═══════════════════════════════════════════════════════ */
        function isDevMode() {
            return new URLSearchParams(window.location.search).get('dev') === '1'
                || sessionStorage.getItem('lp_dev_mode') === '1';
        }

        if (isDevMode()) {
            document.getElementById('devTools').classList.add('show');
        }

        function fillSampleData() {
            document.getElementById('salesName').value     = 'Juan Dela Cruz';
            document.getElementById('salesContact').value  = '+63912-345-6789';
            document.getElementById('salesEmail').value    = 'juan.delacruz@launchpadph.com';
            document.getElementById('salesPosition').value = 'Account Manager';
            document.getElementById('company').value       = 'Sample Company Inc.';
            document.getElementById('address').value       = '123 Sample St., Quezon City';
            document.getElementById('tin').value            = '000-000-000-000';
            document.getElementById('attentionTo').value    = 'Jane Doe';
            document.getElementById('tel').value            = '8123-4567';
            document.getElementById('projectName').value    = 'Sample Project';
            if (!document.getElementById('leadTime').value) document.getElementById('leadTime').value = '7';

            // Items section starts empty, so always add a fresh row
            addItem();
            const wrapper = document.querySelector('#items .item-wrapper:last-child');
            const row = wrapper.querySelector('.item-row');
            row.querySelector('.material').value  = 'Tarpaulin Print';
            row.querySelector('input.sizeW').value     = '4';
            row.querySelector('input.sizeH').value     = '6';
            row.querySelector('input.sizeUnit').value  = 'ft';
            row.querySelector('input.qty').value       = '2';

            calculateTotals();
        }

        /* ── Preview Quote (no save) — available to all users ── */
        async function previewCurrentQuote() {
            document.getElementById('loading').classList.add('show');
            try {
                const data = {
                    controlNumber:  currentControlNumber,
                    revisionNumber: currentRevision,
                    company:      document.getElementById('company').value,
                    address:      document.getElementById('address').value,
                    tin:          document.getElementById('tin').value,
                    attentionTo:  document.getElementById('attentionTo').value,
                    date:         document.getElementById('date').value,
                    tel:          document.getElementById('tel').value,
                    leadTime:     document.getElementById('leadTime').value,
                    projectName:  document.getElementById('projectName').value,
                    paymentTerms: (function() { const s = document.getElementById('paymentTerms'); return s.value === 'others' ? document.getElementById('otherPaymentTerms').value : s.value; })(),
                    salesName:    document.getElementById('salesName').value,
                    salesContact: document.getElementById('salesContact').value,
                    salesEmail:   document.getElementById('salesEmail').value,
                    salesPosition: document.getElementById('salesPosition').value,
                    salesSignature: (_currentProfile && _currentProfile.signature) || null,
                    skipDriveSave: true,
                    items: [],
                    outsourceItems: [],
                    flatRateItems: [],
                    includeVat: document.getElementById('includeVatCheck')?.checked || false,
                    vatExclusive: document.getElementById('vatExclusiveCheck')?.checked || false,
                    bankDetails: document.getElementById('bankDetailsSelect')?.value || 'all'
                };

                document.querySelectorAll('#items .item-wrapper').forEach(wrapper => {
                    const row = wrapper.querySelector('.item-row');
                    data.items.push({
                        material:  row.querySelector('.material').value,
                        sizeW:     row.querySelector('input.sizeW').value || '',
                        sizeH:     row.querySelector('input.sizeH').value || '',
                        sizeUnit:  row.querySelector('input.sizeUnit').value,
                        unitPrice: row.querySelector('input.price').value.replace(/,/g, '') || 0,
                        quantity:  row.querySelector('input.qty').value || 0
                    });
                });

                document.querySelectorAll('#outsourceItems .item-wrapper').forEach(wrapper => {
                    const row = wrapper.querySelector('.item-row');
                    const mults = [];
                    wrapper.querySelectorAll('.outMultVal').forEach(inp => mults.push(parseFloat(inp.value) || 1));
                    data.outsourceItems.push({
                        material:    row.querySelector('.material').value,
                        sizeW:       row.querySelector('input.sizeW').value || '',
                        sizeH:       row.querySelector('input.sizeH').value || '',
                        sizeUnit:    row.querySelector('input.sizeUnit').value,
                        basePrice:   parseFloat(wrapper.querySelector('input.outsourceBase').value) || 0,
                        multipliers: mults,
                        unitPrice:   row.querySelector('input.price').value.replace(/,/g, '') || 0,
                        quantity:    row.querySelector('input.qty').value || 0
                    });
                });

                document.querySelectorAll('#flatRateItems .flat-item-row').forEach(row => {
                    data.flatRateItems.push({
                        material:  row.querySelector('.material').value,
                        unitPrice: String(row.querySelector('input.flatPrice').value || 0).replace(/,/g, ''),
                        quantity:  row.querySelector('input.qty').value || 0
                    });
                });

                if (!data.items.length && !data.outsourceItems.length && !data.flatRateItems.length) {
                    alert('Add at least one item before previewing.');
                    return;
                }

                const response = await fetch(`${API}/api/generate-quotation`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });

                if (!response.ok) throw new Error(await response.text().catch(() => 'Failed to generate preview'));

                const disposition = response.headers.get('Content-Disposition') || '';
                const match = disposition.match(/filename="([^"]+)"/);
                const filename = match ? match[1] : `PREVIEW_${data.controlNumber}.pdf`;
                const blob = await response.blob();
                const url  = window.URL.createObjectURL(new File([blob], filename, { type: 'application/pdf' }));
                window.open(url, '_blank');
                setTimeout(() => window.URL.revokeObjectURL(url), 30000);
            } catch (err) {
                alert(err.message);
            } finally {
                document.getElementById('loading').classList.remove('show');
            }
        }

        async function devGeneratePreview() { await previewCurrentQuote(); }
