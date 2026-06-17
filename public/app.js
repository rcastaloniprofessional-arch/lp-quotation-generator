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
            refreshCtrlDisplay();
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
                const isFlat = wrapper.querySelector('.isFlatFee').checked;

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

                items.push({
                    material:           row.querySelector('input.material').value,
                    sizeW:              row.querySelector('input.sizeW').value,
                    sizeH:              row.querySelector('input.sizeH').value,
                    sizeUnit:           row.querySelector('input.sizeUnit').value,
                    flatFee:            isFlat,
                    flatPrice:          row.querySelector('input.flatPrice').value,
                    multipliers,
                    addons,
                    computedUnitPrice:  row.querySelector('input.price').value,
                    qty:                row.querySelector('input.qty').value
                });
            });

            // Capture outsource items
            const outsourceItems = [];
            document.querySelectorAll('#outsourceItems .item-wrapper').forEach(wrapper => {
                const row = wrapper.querySelector('.item-row');
                const mults = [];
                wrapper.querySelectorAll('.outMultVal').forEach(inp => mults.push(parseFloat(inp.value) || 1));
                outsourceItems.push({
                    material:   row.querySelector('input.material').value,
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
                items,
                outsourceItems
            };
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

            // Rebuild items
            document.getElementById('items').innerHTML = '';
            itemCount = 0;
            Object.keys(multCounters).forEach(k => delete multCounters[k]);
            Object.keys(addonCounters).forEach(k => delete addonCounters[k]);

            snap.items.forEach(saved => {
                addItem();  // creates a fresh row with itemCount id
                const id      = itemCount;
                const wrapper = document.getElementById('item' + id);
                const row     = wrapper.querySelector('.item-row');

                row.querySelector('input.material').value  = saved.material  || '';
                row.querySelector('input.sizeUnit').value  = saved.sizeUnit  || '';
                row.querySelector('input.qty').value       = saved.qty       || 1;

                if (saved.flatFee) {
                    wrapper.querySelector('.isFlatFee').checked = true;
                    toggleFlatFee(id);
                    row.querySelector('input.flatPrice').value = saved.flatPrice || 0;
                } else {
                    row.querySelector('input.sizeW').value = saved.sizeW || '';
                    row.querySelector('input.sizeH').value = saved.sizeH || '';
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

                row.querySelector('input.material').value  = saved.material || '';
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

            calculateTotals();
            refreshCtrlDisplay();
        }

        /* ── Save quote to server (Google Drive) ── */
        async function persistQuote(revision) {
            const snap = captureSnapshot();
            snap.revisions = revision;
            snap.lastSaved = new Date().toISOString();
            const storeKey = currentControlNumber + '|' + companyKey(snap.company);
            await saveQuote(storeKey, snap);
        }

        /* ── History modal ── */
        async function openHistory() {
            document.getElementById('historyModal').classList.add('open');
            document.getElementById('historyList').innerHTML = '<div class="history-empty">Loading...</div>';
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

            let keys = Object.keys(db).sort((a, b) =>
                new Date(db[b].lastSaved) - new Date(db[a].lastSaved)
            );

            if (keys.length === 0) {
                list.innerHTML = '<div class="history-empty">No saved quotes yet.</div>';
                if (countEl) countEl.textContent = '';
                return;
            }

            // Filter: match the whole query as a phrase against "serial company project" combined
            if (query) {
                keys = keys.filter(k => {
                    const s = db[k];
                    const haystack = [
                        (s.controlNumber || k).replace(/_/g, ' '),
                        s.controlNumber || k,
                        s.company    || '',
                        s.projectName|| ''
                    ].join(' ').toLowerCase();
                    return haystack.includes(query);
                });
            }

            if (countEl) {
                const total = Object.keys(db).length;
                countEl.textContent = query
                    ? `${keys.length} of ${total} quote${total !== 1 ? 's' : ''} match`
                    : `${total} quote${total !== 1 ? 's' : ''} total`;
            }

            if (keys.length === 0) {
                list.innerHTML = `<div class="history-empty">No quotes match "<strong>${query}</strong>".</div>`;
                return;
            }

            list.innerHTML = keys.map(k => {
                const s   = db[k];
                const rev = s.revisions > 0 ? `Rev${s.revisions}` : 'Original';
                const saved = new Date(s.lastSaved).toLocaleString('en-PH', { dateStyle:'medium', timeStyle:'short' });
                const safeKey = k.replace(/'/g, "\\'");

                const hl = (text) => {
                    if (!query || !text) return text || '';
                    const idx = text.toLowerCase().indexOf(query);
                    if (idx === -1) return text;
                    return text.slice(0, idx)
                        + `<mark style="background:#fff3b0;border-radius:2px;padding:0 1px;">${text.slice(idx, idx + query.length)}</mark>`
                        + text.slice(idx + query.length);
                };

                const salesPerson = s.salesName ? `<span style="color:#27ae60;font-size:11px;">👤 ${s.salesName}${s.salesPosition ? ' · ' + s.salesPosition : ''}</span>` : '';

                return `
                  <div class="history-item" onclick="loadQuote('${safeKey}')" style="cursor:pointer;" title="Click to load this quote">
                    <div class="history-item-top">
                      <span class="history-ctrl">${hl(s.controlNumber || k)}</span>
                      <div class="history-info">
                        <div class="history-company">${hl(s.company || '(no company)')}</div>
                        <div class="history-meta">
                          ${s.projectName ? `<span style="color:#7f5af0;font-size:11px;">📁 ${hl(s.projectName)}</span> · ` : ''}${salesPerson ? salesPerson + ' · ' : ''}Saved: ${saved}
                        </div>
                      </div>
                      <span class="history-rev">${rev}</span>
                      ${isDevMode() ? `<button class="btn-delete-hist" title="Delete" onclick="deleteQuote(event,'${safeKey}')">🗑</button>` : ''}
                    </div>
                  </div>`;
            }).join('');
        }

        function loadQuote(storeKey) {
            const db   = _cachedDb || {};
            const snap = db[storeKey];
            if (!snap) return;
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
                    sizeW:     it.flatFee ? '' : (it.sizeW || ''),
                    sizeH:     it.flatFee ? '' : (it.sizeH || ''),
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
                e.target.classList.contains('flatPrice') ||
                e.target.classList.contains('qty') ||
                e.target.classList.contains('multVal') ||
                e.target.classList.contains('addon-price') ||
                e.target.classList.contains('addon-qty')
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
                <input type="text" placeholder="Description" class="material">
                <div class="size-cell">
                    <div class="size-split">
                        <input type="number" step="any" min="0" placeholder="W" class="sizeW">
                        <span>×</span>
                        <input type="number" step="any" min="0" placeholder="H" class="sizeH">
                    </div>
                    <input type="number" step="any" min="0" placeholder="Flat Price" class="flatPrice" style="display:none;">
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
                <div class="flatfee-toggle">
                    <label>
                        <input type="checkbox" class="isFlatFee" onclick="toggleFlatFee(${id})">
                        No size (flat fee item — e.g. Installation, Delivery)
                    </label>
                </div>
                <div class="size-dependent" id="sizeDependent${id}">
                    <div class="multiplier-tags" id="multTags${id}"></div>
                    <button type="button" class="btn-add-mult" onclick="addMultiplier(${id})">+ Add Multiplier</button>
                    <div class="mult-summary" id="multFormula${id}">W × H = Unit Price (add multipliers to add more terms)</div>
                </div>
                <div class="addon-section">
                    <div class="addon-section-title">⚙ Add-on Materials <span style="font-weight:normal;color:#999;">(added to Unit Price, hidden in PDF)</span></div>
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

        function toggleFlatFee(id) {
            const wrapper    = document.getElementById('item' + id);
            const isFlat     = wrapper.querySelector('.isFlatFee').checked;
            const sizeSplit  = wrapper.querySelector('.size-split');
            const flatPrice  = wrapper.querySelector('input.flatPrice');
            const sizeUnit   = wrapper.querySelector('input.sizeUnit');
            const sizeDepends = wrapper.querySelector('.size-dependent');

            if (isFlat) {
                sizeSplit.style.display  = 'none';
                flatPrice.style.display  = 'block';
                sizeDepends.style.display = 'none';
                if (!sizeUnit.value) sizeUnit.value = 'lot';
            } else {
                sizeSplit.style.display  = 'flex';
                flatPrice.style.display  = 'none';
                sizeDepends.style.display = '';
                if (sizeUnit.value === 'lot') sizeUnit.value = '';
            }
            calculateTotals();
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
                <input type="text" placeholder="Description (e.g. Buildup 60×60in)" class="material">
                <div class="size-split">
                    <input type="number" step="any" min="0" placeholder="W" class="sizeW">
                    <span>×</span>
                    <input type="number" step="any" min="0" placeholder="H" class="sizeH">
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

        function calculateTotals() {
            let grandTotal = 0;
            document.querySelectorAll('#items .item-wrapper').forEach(wrapper => {
                const row    = wrapper.querySelector('.item-row');
                const isFlat = wrapper.querySelector('.isFlatFee').checked;
                const qty    = parseFloat(row.querySelector('input.qty').value) || 0;

                let w = 0, h = 0, basePrice = 0;
                const multParts = [];

                if (isFlat) {
                    basePrice = parseFloat(row.querySelector('input.flatPrice').value) || 0;
                } else {
                    w = parseFloat(row.querySelector('input.sizeW').value) || 0;
                    h = parseFloat(row.querySelector('input.sizeH').value) || 0;
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
                    if (isFlat) {
                        formulaEl.textContent = `Flat price = ${basePrice.toFixed(2)}`;
                    } else if (multParts.length > 0) {
                        const terms = multParts.map(v => `(${w} × ${h} × ${v})`).join(' + ');
                        formulaEl.textContent = `${terms} = ${basePrice.toFixed(2)}`;
                    } else {
                        formulaEl.textContent = 'W × H = Unit Price (add multipliers to add more terms)';
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

                const subtotal = unitPrice * qty;

                row.querySelector('input.price').value = unitPrice > 0
                    ? unitPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                    : '';

                const formulaEl = wrapper.querySelector('[id^="outFormula"]');
                if (formulaEl) {
                    if (mults.length > 0) {
                        const chain = [basePrice, ...mults].join(' × ');
                        formulaEl.textContent = `${chain} = ${unitPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                    } else {
                        formulaEl.textContent = 'Base Price = Unit Price';
                    }
                }

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
        }

        /* ═══════════════════════════════════════════════════════
           FORM SUBMIT → Generate PDF
        ═══════════════════════════════════════════════════════ */
        document.getElementById('form').addEventListener('submit', async (e) => {
            e.preventDefault();
            document.getElementById('loading').classList.add('show');

            const companyVal = document.getElementById('company').value;

            // Warn if no in-house items, but allow proceeding with outsource-only quotes
            const inHouseCount = document.querySelectorAll('#items .item-wrapper').length;
            if (inHouseCount === 0) {
                const proceed = confirm('No In-House Items added to this quote.\n\nProceed and generate the PDF with Outsource Items only?');
                if (!proceed) {
                    document.getElementById('loading').classList.remove('show');
                    return;
                }
            }

            // Determine revision: check server data for this company+controlNumber
            const db = await loadDB(true);
            const storeKey = currentControlNumber + '|' + companyKey(companyVal);
            const existing = db[storeKey];

            if (existing) {
                // Same company, same control number → revision
                currentRevision = (existing.revisions || 0) + 1;
            } else {
                // New quote → commit serial on server
                const serial = await commitSerial(companyVal);
                currentControlNumber = buildControlNumber(serial);
                currentRevision = 0;
            }

            // Save to Google Drive via server
            await persistQuote(currentRevision);
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
                items: [],
                outsourceItems: [],
                includeVat: document.getElementById('includeVatCheck')?.checked || false,
                vatExclusive: document.getElementById('vatExclusiveCheck')?.checked || false
            };

            document.querySelectorAll('#items .item-wrapper').forEach(wrapper => {
                const row    = wrapper.querySelector('.item-row');
                const isFlat = wrapper.querySelector('.isFlatFee').checked;
                const computedUnitPrice = row.querySelector('input.price').value.replace(/,/g, '') || 0;
                data.items.push({
                    material:  row.querySelector('input.material').value,
                    sizeW:     isFlat ? '' : (row.querySelector('input.sizeW').value || 0),
                    sizeH:     isFlat ? '' : (row.querySelector('input.sizeH').value || 0),
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
                    material:    row.querySelector('input.material').value,
                    sizeW:       row.querySelector('input.sizeW').value || '',
                    sizeH:       row.querySelector('input.sizeH').value || '',
                    sizeUnit:    row.querySelector('input.sizeUnit').value,
                    basePrice,
                    multipliers: mults,
                    unitPrice:   computedUnitPrice,
                    quantity:    row.querySelector('input.qty').value || 0
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
                notice.innerHTML = `✅ PDF saved to Drive!<br><span style="font-size:12px;font-weight:normal;opacity:0.9;">${filename}</span>`;
                document.body.appendChild(notice);
                setTimeout(() => notice.remove(), 5000);

                setTimeout(() => window.URL.revokeObjectURL(url), 30000);

            } catch (err) {
                alert(err.message);
            } finally {
                document.getElementById('loading').classList.remove('show');
            }
        });

        /* ═══════════════════════════════════════════════════════
           DEV TOOLS — only visible with ?dev=1 in the URL.
           Lets you skip manually filling the form and preview a
           PDF without burning a serial number, saving to history,
           or writing a file into the shared Drive folder.
        ═══════════════════════════════════════════════════════ */
        function isDevMode() {
            return new URLSearchParams(window.location.search).get('dev') === '1';
            // To also restrict this to your own machine (hide it from
            // anyone opening the app via your LAN IP), use instead:
            // return new URLSearchParams(window.location.search).get('dev') === '1'
            //     && (location.hostname === 'localhost' || location.hostname === '127.0.0.1');
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
            row.querySelector('input.material').value  = 'Tarpaulin Print';
            row.querySelector('input.sizeW').value     = '4';
            row.querySelector('input.sizeH').value     = '6';
            row.querySelector('input.sizeUnit').value  = 'ft';
            row.querySelector('input.qty').value       = '2';

            calculateTotals();
        }

        async function devGeneratePreview() {
            document.getElementById('loading').classList.add('show');
            try {
                const data = {
                    controlNumber:  'DEV-PREVIEW',
                    revisionNumber: 0,
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
                    skipDriveSave: true, // tells the server: don't write a PDF into the shared Drive folder for this one
                    items: [],
                    outsourceItems: [],
                    includeVat: document.getElementById('includeVatCheck')?.checked || false,
                    vatExclusive: document.getElementById('vatExclusiveCheck')?.checked || false
                };

                document.querySelectorAll('#items .item-wrapper').forEach(wrapper => {
                    const row    = wrapper.querySelector('.item-row');
                    const isFlat = wrapper.querySelector('.isFlatFee').checked;
                    const computedUnitPrice = row.querySelector('input.price').value.replace(/,/g, '') || 0;
                    data.items.push({
                        material:  row.querySelector('input.material').value,
                        sizeW:     isFlat ? '' : (row.querySelector('input.sizeW').value || 0),
                        sizeH:     isFlat ? '' : (row.querySelector('input.sizeH').value || 0),
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
                        material:    row.querySelector('input.material').value,
                        sizeW:       row.querySelector('input.sizeW').value || '',
                        sizeH:       row.querySelector('input.sizeH').value || '',
                        sizeUnit:    row.querySelector('input.sizeUnit').value,
                        basePrice,
                        multipliers: mults,
                        unitPrice:   computedUnitPrice,
                        quantity:    row.querySelector('input.qty').value || 0
                    });
                });

                const inHouseCount   = data.items.length;
                const outsourceCount = data.outsourceItems.length;
                if (inHouseCount === 0 && outsourceCount === 0) {
                    alert('Add at least one In-House or Outsource item first (or click "Fill Sample Data").');
                    return;
                }

                const response = await fetch(`${API}/api/generate-quotation`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });

                if (!response.ok) {
                    const errText = await response.text().catch(() => '');
                    throw new Error(errText || 'Failed to generate preview PDF');
                }

                const blob = await response.blob();
                const namedFile = new File([blob], 'dev-preview.pdf', { type: 'application/pdf' });
                const url = window.URL.createObjectURL(namedFile);
                window.open(url, '_blank');
                setTimeout(() => window.URL.revokeObjectURL(url), 30000);

            } catch (err) {
                alert(err.message);
            } finally {
                document.getElementById('loading').classList.remove('show');
            }
        }
