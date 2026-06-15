<script>
    import { onMount, tick, afterUpdate } from 'svelte';

    // ── State ──────────────────────────────────────────────────────────────────
    let packages = [];
    let selectedPackage = null;
    let selectedPackageId = '';
    let files = [];

    // Tabs: array of { path, content, dirty }
    let tabs = [];
    let activeTabIdx = -1;

    let isLoadingPackages = false;
    let isLoadingFiles = false;
    let isLoadingFile = false;
    let isSaving = false;
    let saveMessage = '';
    let saveMessageType = '';

    let showWarning = false;
    let pendingSave = false; // true = warning triggered by save attempt
    let sidebarOpen = false; // mobile: sidebar drawer

    // Folder expand state: Set of folder paths that are open
    let expandedFolders = new Set();

    let textareaEl;
    let highlightEl;
    let lineNumbersEl;

    const CORE_PACKAGES = ['aurora','aurora-config','aurora-host','delegatus','engineer','router','sandbox','scheduler','tasks','navegador','adb','moondream','ntfy','memory-tools'];

    // ── Derived ────────────────────────────────────────────────────────────────
    $: activeTab = tabs[activeTabIdx] ?? null;
    $: fileContent = activeTab?.content ?? '';
    $: selectedFile = activeTab?.path ?? null;
    $: isCorePackage = selectedPackage ? CORE_PACKAGES.includes(selectedPackage.id) : false;

    // ── Lifecycle ──────────────────────────────────────────────────────────────
    onMount(async () => {
        await loadPackages();
    });

    // afterUpdate: DOM já existe, highlight sempre correto
    afterUpdate(() => {
        if (activeTab && highlightEl) updateHighlight(activeTab.content);
    });

    // ── API calls ──────────────────────────────────────────────────────────────
    async function loadPackages() {
        isLoadingPackages = true;
        try {
            const res = await fetch('/code-editor/packages');
            if (res.ok) {
                packages = await res.json();
                if (packages.length > 0) await selectPackage(packages[0].id);
            }
        } catch (e) { console.error(e); }
        isLoadingPackages = false;
    }

    async function selectPackage(packageId) {
        selectedPackageId = packageId;
        selectedPackage = packages.find(p => p.id === packageId);
        expandedFolders = new Set();
        await loadFiles(packageId);
    }

    async function loadFiles(packageId) {
        isLoadingFiles = true;
        try {
            const res = await fetch(`/code-editor/files?package=${encodeURIComponent(packageId)}`);
            if (res.ok) files = await res.json();
        } catch (e) { console.error(e); }
        isLoadingFiles = false;
    }

    async function openFile(filePath) {
        // If already open, just switch
        const existingIdx = tabs.findIndex(t => t.path === filePath);
        if (existingIdx !== -1) {
            activeTabIdx = existingIdx;
            sidebarOpen = false;
            return;
        }
        isLoadingFile = true;
        try {
            const res = await fetch(`/code-editor/file/read?package=${encodeURIComponent(selectedPackage.id)}&path=${encodeURIComponent(filePath)}`);
            if (res.ok) {
                const data = await res.json();
                tabs = [...tabs, { path: filePath, content: data.content, dirty: false }];
                activeTabIdx = tabs.length - 1;
                sidebarOpen = false;
                await tick();
                syncScroll();
            }
        } catch (e) { console.error(e); }
        isLoadingFile = false;
    }

    async function saveFile() {
        if (!activeTab || !selectedPackage) return;
        // Show warning on first save attempt for core packages
        if (isCorePackage && !pendingSave) {
            showWarning = true;
            pendingSave = true;
            return;
        }
        pendingSave = false;
        isSaving = true;
        saveMessage = '';
        try {
            const res = await fetch('/code-editor/file/write', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ package: selectedPackage.id, path: activeTab.path, content: activeTab.content })
            });
            if (res.ok) {
                saveMessage = 'Saved'; saveMessageType = 'success';
                tabs[activeTabIdx].dirty = false;
                tabs = [...tabs];
            } else {
                const err = await res.json();
                saveMessage = err.error || 'Error'; saveMessageType = 'error';
            }
        } catch { saveMessage = 'Network error'; saveMessageType = 'error'; }
        isSaving = false;
        setTimeout(() => { saveMessage = ''; }, 2500);
    }

    function closeTab(idx, e) {
        e?.stopPropagation();
        tabs = tabs.filter((_, i) => i !== idx);
        if (activeTabIdx >= tabs.length) activeTabIdx = tabs.length - 1;
        else if (activeTabIdx > idx) activeTabIdx--;
    }

    function confirmSave() { showWarning = false; saveFile(); }
    function cancelSave() { showWarning = false; pendingSave = false; }

    // ── Editor input ──────────────────────────────────────────────────────────
    function onInput(e) {
        if (!activeTab) return;
        tabs[activeTabIdx].content = e.target.value;
        tabs[activeTabIdx].dirty = true;
        tabs = [...tabs];
        updateHighlight(tabs[activeTabIdx].content);
    }

    function onKeydown(e) {
        if (e.key === 'Tab') {
            e.preventDefault();
            const ta = e.target;
            const start = ta.selectionStart;
            const end = ta.selectionEnd;
            const val = ta.value;
            ta.value = val.slice(0, start) + '    ' + val.slice(end);
            ta.selectionStart = ta.selectionEnd = start + 4;
            onInput({ target: ta });
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            saveFile();
        }
        if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
            e.preventDefault();
            changeFontSize(1);
        }
        if ((e.ctrlKey || e.metaKey) && e.key === '-') {
            e.preventDefault();
            changeFontSize(-1);
        }
    }

    function syncScroll() {
        if (!textareaEl || !highlightEl || !lineNumbersEl) return;
        highlightEl.scrollTop = textareaEl.scrollTop;
        highlightEl.scrollLeft = textareaEl.scrollLeft;
        lineNumbersEl.scrollTop = textareaEl.scrollTop;
    }

    // ── Syntax highlight (no libs!) ────────────────────────────────────────────
    // Strategy: escape HTML first, then apply regex token passes IN ORDER.
    // Order matters: strings first, then comments, then keywords, then operators.
    // Each pass wraps matched text in a span; subsequent passes skip already-wrapped spans.

    const ESCAPE = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' };
    function escHtml(s) { return s.replace(/[&<>"]/g, c => ESCAPE[c]); }

    // Tokeniser: returns array of {type, value}
    function tokenize(code, lang) {
        // Simple line-by-line, character-walk tokenizer
        const tokens = [];
        let i = 0;
        const n = code.length;

        const isAlpha = c => /[a-zA-Z_$]/.test(c);
        const isAlNum = c => /[a-zA-Z0-9_$]/.test(c);
        const isDigit = c => /[0-9]/.test(c);

        const JS_KEYWORDS = new Set(['break','case','catch','class','const','continue','debugger','default','delete','do','else','export','extends','false','finally','for','from','function','if','import','in','instanceof','let','new','null','of','return','static','super','switch','this','throw','true','try','typeof','undefined','var','void','while','yield','async','await']);
        const TS_KEYWORDS = new Set([...JS_KEYWORDS,'type','interface','enum','implements','declare','abstract','namespace','readonly','as','keyof','infer','never','any','unknown','string','number','boolean','object','symbol']);
        const JSON_KEYWORDS = new Set(['true','false','null']);
        const CSS_AT = new Set(['@import','@media','@keyframes','@font-face','@supports','@charset','@layer']);

        const kwSet = (lang === 'ts' || lang === 'svelte') ? TS_KEYWORDS
                    : lang === 'json' ? JSON_KEYWORDS
                    : JS_KEYWORDS;

        while (i < n) {
            const ch = code[i];

            // Newline
            if (ch === '\n') { tokens.push({ t: 'newline', v: '\n' }); i++; continue; }

            // Single-line comment //
            if ((lang !== 'css' && lang !== 'json') && ch === '/' && code[i+1] === '/') {
                let end = i; while (end < n && code[end] !== '\n') end++;
                tokens.push({ t: 'comment', v: code.slice(i, end) }); i = end; continue;
            }

            // Block comment /* */
            if (ch === '/' && code[i+1] === '*') {
                let end = i+2;
                while (end < n && !(code[end] === '*' && code[end+1] === '/')) end++;
                end = Math.min(end+2, n);
                tokens.push({ t: 'comment', v: code.slice(i, end) }); i = end; continue;
            }

            // HTML/Svelte comment <!-- -->
            if ((lang === 'svelte' || lang === 'html') && ch === '<' && code.slice(i,i+4) === '<!--') {
                let end = i+4;
                while (end < n && code.slice(end,end+3) !== '-->') end++;
                end = Math.min(end+3, n);
                tokens.push({ t: 'comment', v: code.slice(i, end) }); i = end; continue;
            }

            // Hash comment (yaml/shell style)
            if ((lang === 'yaml' || lang === 'yml') && ch === '#') {
                let end = i; while (end < n && code[end] !== '\n') end++;
                tokens.push({ t: 'comment', v: code.slice(i, end) }); i = end; continue;
            }

            // Template literal `...`
            if (ch === '`') {
                let end = i+1;
                while (end < n && code[end] !== '`') {
                    if (code[end] === '\\') end++;
                    end++;
                }
                end = Math.min(end+1, n);
                tokens.push({ t: 'string', v: code.slice(i, end) }); i = end; continue;
            }

            // String " or '
            if (ch === '"' || ch === "'") {
                let end = i+1;
                while (end < n && code[end] !== ch) {
                    if (code[end] === '\\') end++;
                    if (code[end] === '\n') break;
                    end++;
                }
                end = Math.min(end+1, n);
                tokens.push({ t: 'string', v: code.slice(i, end) }); i = end; continue;
            }

            // Number
            if (isDigit(ch) || (ch === '.' && isDigit(code[i+1] || ''))) {
                let end = i+1;
                while (end < n && /[0-9._xXa-fA-FbBoOeE+\-]/.test(code[end])) end++;
                tokens.push({ t: 'number', v: code.slice(i, end) }); i = end; continue;
            }

            // JSON key (string before colon)
            if (lang === 'json' && ch === '"') {
                let end = i+1;
                while (end < n && code[end] !== '"') { if (code[end] === '\\') end++; end++; }
                end = Math.min(end+1, n);
                // peek ahead for ':'
                let after = end;
                while (after < n && (code[after] === ' ' || code[after] === '\t')) after++;
                if (code[after] === ':') {
                    tokens.push({ t: 'key', v: code.slice(i, end) }); i = end; continue;
                } else {
                    tokens.push({ t: 'string', v: code.slice(i, end) }); i = end; continue;
                }
            }

            // Identifier / keyword
            if (isAlpha(ch)) {
                let end = i+1;
                while (end < n && isAlNum(code[end])) end++;
                const word = code.slice(i, end);
                if (kwSet.has(word)) tokens.push({ t: 'keyword', v: word });
                else tokens.push({ t: 'ident', v: word });
                i = end; continue;
            }

            // CSS property (word before colon, not selector)
            if (lang === 'css' && isAlpha(ch)) {
                let end = i+1;
                while (end < n && /[a-zA-Z0-9-]/.test(code[end])) end++;
                const word = code.slice(i, end);
                let after = end;
                while (after < n && code[after] === ' ') after++;
                if (code[after] === ':') tokens.push({ t: 'property', v: word });
                else tokens.push({ t: 'ident', v: word });
                i = end; continue;
            }

            // Operator / punctuation
            if (/[=+\-*/%<>!&|^~?:;,.()\[\]{}]/.test(ch)) {
                tokens.push({ t: 'op', v: ch }); i++; continue;
            }

            // Whitespace run
            if (ch === ' ' || ch === '\t') {
                let end = i+1;
                while (end < n && (code[end] === ' ' || code[end] === '\t')) end++;
                tokens.push({ t: 'ws', v: code.slice(i, end) }); i = end; continue;
            }

            // Fallback
            tokens.push({ t: 'other', v: ch }); i++;
        }
        return tokens;
    }

    function tokensToHtml(tokens) {
        const COLOR = {
            comment: 'var(--hl-comment)',
            string:  'var(--hl-string)',
            number:  'var(--hl-number)',
            keyword: 'var(--hl-keyword)',
            key:     'var(--hl-key)',
            property:'var(--hl-property)',
            op:      'var(--hl-op)',
            ident:   '', // no color
            ws:      '',
            newline: '',
            other:   '',
        };
        return tokens.map(tk => {
            const esc = escHtml(tk.v);
            if (tk.t === 'newline') return '\n';
            const col = COLOR[tk.t];
            if (!col) return esc;
            return `<span style="color:${col}">${esc}</span>`;
        }).join('');
    }

    function getLang(filePath) {
        if (!filePath) return 'js';
        const ext = filePath.split('.').pop().toLowerCase();
        return ext || 'js';
    }

    async function updateHighlight(code) {
        if (!highlightEl) return;
        const lang = getLang(activeTab?.path);
        const tokens = tokenize(code || '', lang);
        highlightEl.innerHTML = tokensToHtml(tokens) + '\n'; // trailing newline keeps height in sync
        if (lineNumbersEl) {
            const lines = (code || '').split('\n').length;
            lineNumbersEl.innerHTML = Array.from({ length: lines }, (_, i) => `<div>${i+1}</div>`).join('');
        }
    }

    // ── Helpers ────────────────────────────────────────────────────────────────
    function getFileIcon(ext) {
        const m = { js:'js', ts:'ts', svelte:'sv', json:'{}', md:'md', prisma:'db', html:'ht', css:'cs', yaml:'ym', yml:'ym' };
        return m[ext] || '  ';
    }

    function getIconClass(ext) {
        const m = { js:'ic-js', ts:'ic-ts', svelte:'ic-sv', json:'ic-json', md:'ic-md', css:'ic-css', html:'ic-html', yaml:'ic-yaml', yml:'ic-yaml', prisma:'ic-db' };
        return m[ext] || 'ic-file';
    }

    function shortName(filePath) {
        return filePath?.split('/').pop() ?? '';
    }

    // Flatten nested tree into ordered list for rendering (Svelte templates can't recurse)
    function renderTree(node, parentPath, depth) {
        const result = [];
        // Merge folders and files, sort alphabetically (VSCode default)
        const folders = Object.keys(node.children).sort((a, b) => a.localeCompare(b));
        const sortedFiles = [...node.files].sort((a, b) =>
            a.path.split('/').pop().localeCompare(b.path.split('/').pop())
        );

        // Build merged list: folder entries + file entries, sorted by name
        const entries = [
            ...folders.map(name => ({ kind: 'folder', name })),
            ...sortedFiles.map(f => ({ kind: 'file', name: f.path.split('/').pop(), file: f }))
        ].sort((a, b) => a.name.localeCompare(b.name));

        for (const entry of entries) {
            if (entry.kind === 'folder') {
                const folderPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
                result.push({ type: 'folder', name: entry.name, path: folderPath, depth });
                if (expandedFolders.has(folderPath)) {
                    result.push(...renderTree(node.children[entry.name], folderPath, depth + 1));
                }
            } else {
                result.push({ type: 'file', file: entry.file, depth });
            }
        }
        return result;
    }

    function onPackageChange(e) { selectPackage(e.target.value); }

    // ── Folder tree ────────────────────────────────────────────────────────────
    // Build a nested tree from the flat files array
    function buildTree(files) {
        const root = { children: {}, files: [] };
        for (const f of files) {
            const parts = f.path.split('/');
            let node = root;
            for (let i = 0; i < parts.length - 1; i++) {
                const seg = parts[i];
                if (!node.children[seg]) node.children[seg] = { children: {}, files: [] };
                node = node.children[seg];
            }
            node.files.push(f);
        }
        return root;
    }

    function toggleFolder(folderPath) {
        const next = new Set(expandedFolders);
        if (next.has(folderPath)) next.delete(folderPath);
        else next.add(folderPath);
        expandedFolders = next;
    }

    // ── Tab label disambiguation ───────────────────────────────────────────────
    // If two open tabs share the same filename, show "parent/file.ext" instead
    function tabLabel(tab) {
        const name = shortName(tab.path);
        const siblings = tabs.filter(t => shortName(t.path) === name && t.path !== tab.path);
        if (siblings.length === 0) return name;
        // Show one parent segment for disambiguation
        const parts = tab.path.split('/');
        return parts.length >= 2 ? `${parts[parts.length - 2]}/${name}` : name;
    }

    $: fileTree = buildTree(files);

    let editorFontSize = 13; // px, clamped 10–24
    const FONT_MIN = 10, FONT_MAX = 24;
    function changeFontSize(delta) {
        editorFontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, editorFontSize + delta));
    }
    function onEditorWheel(e) {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            changeFontSize(e.deltaY < 0 ? 1 : -1);
        }
    }
</script>

<!-- ── Markup ──────────────────────────────────────────────────────────────── -->
<div class="vsc">

    <!-- Activity bar (left, desktop) -->
    <aside class="activitybar" aria-label="Activity bar">
        <button class="ab-btn active" title="Explorer" on:click={() => sidebarOpen = !sidebarOpen}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>
        </button>
        <button class="ab-btn" title="Search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="22" y2="22"/></svg>
        </button>
    </aside>

    <!-- Sidebar (file tree) -->
    <div class="sidebar {sidebarOpen ? 'open' : ''}" aria-label="File explorer">
        <div class="sidebar-pkg">
            <span class="sidebar-section">PACKAGE</span>
            <select value={selectedPackageId} on:change={onPackageChange} disabled={isLoadingPackages} class="pkg-select">
                {#each packages as pkg}
                    <option value={pkg.id}>{pkg.name}</option>
                {/each}
            </select>
        </div>

        <div class="sidebar-section-label">
            EXPLORER
            {#if isCorePackage}<span class="core-badge">CORE</span>{/if}
        </div>

        <div class="file-tree" role="tree">
            {#if isLoadingFiles}
                <div class="tree-msg">Loading…</div>
            {:else if files.length === 0}
                <div class="tree-msg">No files</div>
            {:else}
                {#each renderTree(fileTree, '', 0) as node}
                    {#if node.type === 'folder'}
                        <button
                            class="tree-item tree-folder"
                            style="padding-left: {12 + node.depth * 14}px"
                            on:click={() => toggleFolder(node.path)}
                            title={node.path}
                        >
                            <span class="folder-arrow" class:open={expandedFolders.has(node.path)}>›</span>
                            <span class="tree-icon ic-folder" aria-hidden="true">
                                <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M1.5 3a1 1 0 011-1h3.172a1 1 0 01.707.293L7.086 3H13.5a1 1 0 011 1v8a1 1 0 01-1 1h-12a1 1 0 01-1-1V3z"/></svg>
                            </span>
                            <span class="tree-name">{node.name}</span>
                        </button>
                    {:else}
                        <button
                            class="tree-item {selectedFile === node.file.path ? 'active' : ''}"
                            style="padding-left: {12 + node.depth * 14}px"
                            role="treeitem"
                            on:click={() => openFile(node.file.path)}
                            title={node.file.path}
                        >
                            <span class="tree-icon {getIconClass(node.file.ext)}" aria-hidden="true">{getFileIcon(node.file.ext)}</span>
                            <span class="tree-name">{node.file.path.split('/').pop()}</span>
                        </button>
                    {/if}
                {/each}
            {/if}
        </div>
    </div>

    <!-- Sidebar backdrop (mobile) -->
    {#if sidebarOpen}
        <div class="sidebar-backdrop" on:click={() => sidebarOpen = false} aria-hidden="true"></div>
    {/if}

    <!-- Main editor area -->
    <div class="editor-main">

        <!-- Mobile top bar -->
        <div class="mobile-topbar">
            <button class="topbar-btn" on:click={() => sidebarOpen = !sidebarOpen} aria-label="Toggle sidebar">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
            </button>
            <span class="topbar-title">{selectedPackage?.name ?? 'Code Editor'}</span>
            <div class="topbar-right">
                {#if saveMessage}<span class="save-badge {saveMessageType}">{saveMessage}</span>{/if}
                <button class="save-btn" on:click={saveFile} disabled={isSaving || !activeTab}>
                    {isSaving ? '…' : 'Save'}
                </button>
            </div>
        </div>

        <!-- Tab bar -->
        <div class="tabbar" role="tablist">
            {#each tabs as tab, i}
                {@const ext = tab.path.split('.').pop()}
                <button
                    class="tab {activeTabIdx === i ? 'active' : ''}"
                    role="tab"
                    aria-selected={activeTabIdx === i}
                    on:click={() => activeTabIdx = i}
                    title={tab.path}
                >
                    <span class="tab-icon {getIconClass(ext)}" aria-hidden="true">{getFileIcon(ext)}</span>
                    <span class="tab-name">{tabLabel(tab)}</span>
                    {#if tab.dirty}<span class="tab-dot" aria-label="unsaved"></span>{/if}
                    <button class="tab-close" on:click={(e) => closeTab(i, e)} aria-label="Close tab">×</button>
                </button>
            {/each}
        </div>

        <!-- Desktop save bar (above editor) -->
        <div class="desktop-savebar">
            {#if activeTab}<span class="breadcrumb">{selectedPackage?.name} / {activeTab.path}</span>{/if}
            <div class="savebar-right">
                {#if saveMessage}<span class="save-badge {saveMessageType}">{saveMessage}</span>{/if}
                <button class="save-btn" on:click={saveFile} disabled={isSaving || !activeTab} title="Save (⌘S / Ctrl+S)">
                    {isSaving ? 'Saving…' : 'Save'}
                </button>
            </div>
        </div>

        <!-- Code editor -->
        <div class="editor-wrap" on:wheel={onEditorWheel} style="--editor-fs: {editorFontSize}px">
            {#if !activeTab}
                <div class="empty-state">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" width="48" height="48" opacity=".25"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    <p>Open a file from the explorer</p>
                </div>
            {:else if isLoadingFile}
                <div class="empty-state"><p>Loading…</p></div>
            {:else}
                <div class="line-numbers" bind:this={lineNumbersEl} aria-hidden="true"></div>
                <div class="editor-inner">
                    <!-- Highlight layer (behind textarea) -->
                    <pre class="highlight-layer" bind:this={highlightEl} aria-hidden="true"></pre>
                    <!-- Transparent textarea on top -->
                    <textarea
                        bind:this={textareaEl}
                        class="code-textarea"
                        value={fileContent}
                        spellcheck="false"
                        autocapitalize="off"
                        autocomplete="off"
                        autocorrect="off"
                        on:input={onInput}
                        on:keydown={onKeydown}
                        on:scroll={syncScroll}
                        aria-label="Code editor"
                    ></textarea>
                </div>
            {/if}
        </div>

        <!-- Status bar -->
        <div class="statusbar">
            {#if activeTab}
                <span>{getLang(activeTab.path).toUpperCase()}</span>
                <span>{activeTab.dirty ? '● Modified' : 'Saved'}</span>
            {:else}
                <span>Ready</span>
            {/if}
            <span class="statusbar-right">
                <button class="fs-btn" on:click={() => changeFontSize(-1)} disabled={editorFontSize <= FONT_MIN} title="Decrease font size (Ctrl+-)">A−</button>
                <span class="fs-label">{editorFontSize}px</span>
                <button class="fs-btn" on:click={() => changeFontSize(1)} disabled={editorFontSize >= FONT_MAX} title="Increase font size (Ctrl+=)">A+</button>
            </span>
        </div>
    </div>
</div>

<!-- Warning modal -->
{#if showWarning}
    <div class="modal-bg" on:click={cancelSave} role="dialog" aria-modal="true">
        <div class="modal" on:click|stopPropagation>
            <div class="modal-icon">⚠️</div>
            <h2>Core Package</h2>
            <p>You're about to save changes to <strong>{selectedPackage?.name}</strong>, a core system package.</p>
            <p class="modal-warn">Changes can break the entire Aurora system.</p>
            <div class="modal-btns">
                <button class="btn-cancel" on:click={cancelSave}>Cancel</button>
                <button class="btn-confirm" on:click={confirmSave}>Save anyway</button>
            </div>
        </div>
    </div>
{/if}

<!-- ── Styles ──────────────────────────────────────────────────────────────── -->
<style>
    /* ── Tokens ── */
    :global(:root) {
        --vsc-bg: #1e1e1e;
        --vsc-surface: #252526;
        --vsc-surface2: #2d2d2d;
        --vsc-border: #3c3c3c;
        --vsc-text: #d4d4d4;
        --vsc-muted: #858585;
        --vsc-accent: #007acc;
        --vsc-accent2: #264f78;
        --vsc-tab-active: #1e1e1e;
        --vsc-tab-inactive: #2d2d2d;
        --vsc-ab: #333333;
        --vsc-status: #007acc;
        --vsc-status-text: #fff;
        /* Syntax */
        --hl-comment: #6a9955;
        --hl-string: #ce9178;
        --hl-number: #b5cea8;
        --hl-keyword: #569cd6;
        --hl-key: #9cdcfe;
        --hl-property: #9cdcfe;
        --hl-op: #d4d4d4;
    }

    /* ── Layout ── */
    .vsc {
        display: flex;
        height: 100vh;
        background: var(--vsc-bg);
        color: var(--vsc-text);
        font-family: 'Consolas', 'Menlo', 'Monaco', monospace;
        overflow: hidden;
    }

    /* ── Activity bar ── */
    .activitybar {
        width: 48px;
        min-width: 48px;
        background: var(--vsc-ab);
        display: flex;
        flex-direction: column;
        align-items: center;
        padding-top: 8px;
        gap: 4px;
        border-right: 1px solid var(--vsc-border);
    }
    .ab-btn {
        width: 36px;
        height: 36px;
        border-radius: 4px;
        background: transparent;
        border: none;
        color: var(--vsc-muted);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: color .12s;
        padding: 6px;
    }
    .ab-btn:hover, .ab-btn.active { color: var(--vsc-text); }
    .ab-btn.active { border-left: 2px solid var(--vsc-accent); }
    .ab-btn svg { width: 20px; height: 20px; }

    /* ── Sidebar ── */
    .sidebar {
        width: 240px;
        min-width: 240px;
        background: var(--vsc-surface);
        display: flex;
        flex-direction: column;
        border-right: 1px solid var(--vsc-border);
        overflow: hidden;
        transition: transform .2s ease;
    }
    .sidebar-pkg {
        padding: 8px 12px;
        border-bottom: 1px solid var(--vsc-border);
    }
    .sidebar-section {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: .1em;
        color: var(--vsc-muted);
        font-family: system-ui, sans-serif;
    }
    .sidebar-section-label {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: .08em;
        color: var(--vsc-muted);
        padding: 8px 12px 4px;
        display: flex;
        align-items: center;
        gap: 6px;
        font-family: system-ui, sans-serif;
        text-transform: uppercase;
    }
    .core-badge {
        font-size: 9px;
        background: #c53030;
        color: #fff;
        padding: 1px 5px;
        border-radius: 3px;
        letter-spacing: .05em;
    }
    .pkg-select {
        width: 100%;
        margin-top: 4px;
        background: var(--vsc-surface2);
        border: 1px solid var(--vsc-border);
        border-radius: 3px;
        color: var(--vsc-text);
        font-size: 12px;
        padding: 4px 6px;
        font-family: system-ui, sans-serif;
        cursor: pointer;
    }
    .file-tree {
        flex: 1;
        overflow-y: auto;
        padding: 4px 0;
    }
    .file-tree::-webkit-scrollbar { width: 4px; }
    .file-tree::-webkit-scrollbar-thumb { background: rgba(255,255,255,.1); border-radius: 2px; }
    .tree-msg {
        font-size: 12px;
        color: var(--vsc-muted);
        padding: 12px 16px;
        font-family: system-ui, sans-serif;
    }
    .tree-item {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 100%;
        padding: 3px 12px;
        background: transparent;
        border: none;
        color: var(--vsc-text);
        cursor: pointer;
        font-size: 13px;
        font-family: system-ui, sans-serif;
        text-align: left;
        white-space: nowrap;
        overflow: hidden;
    }
    .tree-item:hover { background: rgba(255,255,255,.05); }
    .tree-item.active { background: var(--vsc-accent2); }
    .tree-icon {
        font-size: 10px;
        font-weight: 700;
        min-width: 20px;
        text-align: center;
        border-radius: 2px;
        padding: 1px 3px;
        font-family: system-ui, sans-serif;
    }
    .ic-js  { background:#f0db4f; color:#000; }
    .ic-ts  { background:#3178c6; color:#fff; }
    .ic-sv  { background:#ff3e00; color:#fff; }
    .ic-json{ background:#44475a; color:#f1fa8c; }
    .ic-md  { background:#555; color:#aaa; }
    .ic-css { background:#264de4; color:#fff; }
    .ic-html{ background:#e34c26; color:#fff; }
    .ic-yaml{ background:#cb171e; color:#fff; }
    .ic-db  { background:#336791; color:#fff; }
    .tree-folder { color: var(--vsc-muted); }
    .tree-folder:hover { color: var(--vsc-text); }
    .folder-arrow {
        display: inline-block;
        font-size: 14px;
        line-height: 1;
        width: 12px;
        transition: transform .12s;
        transform: rotate(0deg);
        color: var(--vsc-muted);
        flex-shrink: 0;
    }
    .folder-arrow.open { transform: rotate(90deg); }
    .ic-folder { background: transparent; color: #dcb862; padding: 0; min-width: 16px; }
    .ic-folder svg { display: block; }
    .tree-name { overflow: hidden; text-overflow: ellipsis; font-size: 13px; }

    /* Mobile sidebar backdrop */
    .sidebar-backdrop {
        display: none;
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,.5);
        z-index: 10;
    }

    /* ── Editor main ── */
    .editor-main {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        min-width: 0;
    }

    /* Mobile topbar — hidden on desktop */
    .mobile-topbar {
        display: none;
        align-items: center;
        gap: 8px;
        padding: 0 10px;
        height: 44px;
        background: var(--vsc-surface);
        border-bottom: 1px solid var(--vsc-border);
        flex-shrink: 0;
    }
    .topbar-btn {
        background: transparent;
        border: none;
        color: var(--vsc-muted);
        cursor: pointer;
        padding: 6px;
        display: flex;
    }
    .topbar-title {
        flex: 1;
        font-size: 13px;
        font-weight: 500;
        font-family: system-ui, sans-serif;
        color: var(--vsc-text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .topbar-right {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
    }

    /* Desktop save bar — hidden on mobile */
    .desktop-savebar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 4px 12px;
        background: var(--vsc-surface);
        border-bottom: 1px solid var(--vsc-border);
        flex-shrink: 0;
        min-height: 30px;
    }
    .breadcrumb {
        font-size: 12px;
        color: var(--vsc-muted);
        font-family: system-ui, sans-serif;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .savebar-right {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
    }

    /* ── Tab bar ── */
    .tabbar {
        display: flex;
        overflow-x: auto;
        background: var(--vsc-surface2);
        flex-shrink: 0;
        border-bottom: 1px solid var(--vsc-border);
    }
    .tabbar::-webkit-scrollbar { height: 2px; }
    .tabbar::-webkit-scrollbar-thumb { background: rgba(255,255,255,.1); }
    .tab {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 0 8px 0 10px;
        height: 35px;
        background: var(--vsc-tab-inactive);
        border: none;
        border-right: 1px solid var(--vsc-border);
        color: var(--vsc-muted);
        cursor: pointer;
        white-space: nowrap;
        font-size: 13px;
        font-family: system-ui, sans-serif;
        transition: color .1s, background .1s;
        position: relative;
    }
    .tab:hover { color: var(--vsc-text); background: var(--vsc-surface); }
    .tab.active {
        background: var(--vsc-tab-active);
        color: var(--vsc-text);
        border-top: 1px solid var(--vsc-accent);
    }
    .tab-icon {
        font-size: 9px;
        font-weight: 700;
        min-width: 18px;
        text-align: center;
        border-radius: 2px;
        padding: 1px 3px;
        font-family: system-ui, sans-serif;
    }
    .tab-name { max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
    .tab-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--vsc-text);
        display: inline-block;
        margin: 0 2px;
    }
    .tab-close {
        background: transparent;
        border: none;
        color: inherit;
        cursor: pointer;
        padding: 0 2px;
        font-size: 16px;
        line-height: 1;
        opacity: 0;
        transition: opacity .1s;
        display: flex;
        align-items: center;
    }
    .tab:hover .tab-close, .tab.active .tab-close { opacity: .7; }
    .tab-close:hover { opacity: 1 !important; }

    /* ── Editor area ── */
    .editor-wrap {
        flex: 1;
        display: flex;
        overflow: hidden;
        position: relative;
        background: var(--vsc-bg);
    }
    .line-numbers {
        width: 48px;
        min-width: 48px;
        background: var(--vsc-bg);
        color: var(--vsc-muted);
        font-size: var(--editor-fs, 13px);
        line-height: 1.6;
        padding: 16px 0;
        text-align: right;
        padding-right: 10px;
        overflow: hidden;
        user-select: none;
        border-right: 1px solid var(--vsc-border);
        font-family: 'Consolas', 'Menlo', 'Monaco', monospace;
    }
    .line-numbers :global(div) {
        height: calc(1.6em);
    }
    .editor-inner {
        flex: 1;
        position: relative;
        overflow: hidden;
    }
    .highlight-layer, .code-textarea {
        position: absolute;
        inset: 0;
        margin: 0;
        border: none;
        outline: none;
        padding: 16px;
        font-size: var(--editor-fs, 13px);
        line-height: 1.6;
        font-family: 'Consolas', 'Menlo', 'Monaco', monospace;
        tab-size: 4;
        white-space: pre;
        overflow: auto;
        box-sizing: border-box;
        word-wrap: normal;
    }
    .highlight-layer {
        background: transparent;
        color: var(--vsc-text);
        pointer-events: none;
        z-index: 1;
        overflow: hidden; /* sync handled via js */
    }
    .code-textarea {
        background: transparent;
        color: transparent;
        caret-color: var(--vsc-text);
        resize: none;
        z-index: 2;
        spellcheck: false;
    }
    .code-textarea::-webkit-scrollbar { width: 10px; height: 10px; }
    .code-textarea::-webkit-scrollbar-track { background: var(--vsc-surface); }
    .code-textarea::-webkit-scrollbar-thumb { background: rgba(255,255,255,.15); border-radius: 5px; }
    .code-textarea::selection { background: rgba(38,79,120,.7); }

    .empty-state {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 12px;
        color: var(--vsc-muted);
        font-family: system-ui, sans-serif;
        font-size: 13px;
    }
    .empty-state p { margin: 0; }

    /* ── Status bar ── */
    .statusbar {
        display: flex;
        align-items: center;
        gap: 16px;
        padding: 0 12px;
        height: 22px;
        background: var(--vsc-status);
        color: var(--vsc-status-text);
        font-size: 11px;
        font-family: system-ui, sans-serif;
        flex-shrink: 0;
    }
    .statusbar-right {
        margin-left: auto;
        display: flex;
        align-items: center;
        gap: 4px;
    }
    .fs-btn {
        background: transparent;
        border: none;
        color: var(--vsc-status-text);
        cursor: pointer;
        font-size: 11px;
        font-family: system-ui, sans-serif;
        padding: 0 5px;
        height: 18px;
        border-radius: 2px;
        opacity: .85;
        transition: opacity .1s, background .1s;
        line-height: 1;
    }
    .fs-btn:hover:not(:disabled) { opacity: 1; background: rgba(255,255,255,.15); }
    .fs-btn:disabled { opacity: .35; cursor: default; }
    .fs-label {
        font-size: 11px;
        min-width: 28px;
        text-align: center;
        opacity: .8;
    }

    /* ── Save/action buttons ── */
    .save-btn {
        background: transparent;
        border: 1px solid rgba(255,255,255,.2);
        color: var(--vsc-text);
        border-radius: 3px;
        padding: 3px 10px;
        font-size: 12px;
        cursor: pointer;
        font-family: system-ui, sans-serif;
        transition: background .1s;
        white-space: nowrap;
    }
    .save-btn:hover:not(:disabled) { background: rgba(255,255,255,.08); }
    .save-btn:disabled { opacity: .4; cursor: not-allowed; }
    .save-badge {
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 3px;
        font-family: system-ui, sans-serif;
        white-space: nowrap;
    }
    .save-badge.success { color: #4ade80; background: rgba(74,222,128,.1); }
    .save-badge.error   { color: #f87171; background: rgba(248,113,113,.1); }

    /* ── Warning modal ── */
    .modal-bg {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,.65);
        backdrop-filter: blur(2px);
        z-index: 100;
        display: flex;
        align-items: center;
        justify-content: center;
    }
    .modal {
        background: var(--vsc-surface);
        border: 1px solid var(--vsc-border);
        border-radius: 6px;
        padding: 28px 24px;
        max-width: 380px;
        width: 90%;
        text-align: center;
        font-family: system-ui, sans-serif;
    }
    .modal-icon { font-size: 40px; margin-bottom: 12px; }
    .modal h2 { font-size: 16px; font-weight: 600; margin: 0 0 10px; color: var(--vsc-text); }
    .modal p { font-size: 13px; color: var(--vsc-muted); line-height: 1.6; margin: 0 0 8px; }
    .modal-warn { color: #f87171 !important; }
    .modal-btns { display: flex; gap: 10px; justify-content: center; margin-top: 20px; }
    .btn-cancel {
        background: transparent;
        border: 1px solid var(--vsc-border);
        color: var(--vsc-muted);
        padding: 8px 18px;
        border-radius: 4px;
        font-size: 13px;
        cursor: pointer;
        transition: all .1s;
    }
    .btn-cancel:hover { color: var(--vsc-text); }
    .btn-confirm {
        background: var(--vsc-accent);
        border: none;
        color: #fff;
        padding: 8px 18px;
        border-radius: 4px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: opacity .1s;
    }
    .btn-confirm:hover { opacity: .85; }

    /* ── Mobile breakpoint (≤768px) ── */
    @media (max-width: 768px) {
        .activitybar { display: none; }
        .sidebar {
            position: fixed;
            top: 0;
            left: 0;
            bottom: 0;
            z-index: 20;
            transform: translateX(-100%);
            width: 280px;
            min-width: 280px;
            box-shadow: 4px 0 20px rgba(0,0,0,.5);
        }
        .sidebar.open { transform: translateX(0); }
        .sidebar-backdrop { display: block; }
        .mobile-topbar { display: flex; }
        .desktop-savebar { display: none; }
        .line-numbers { width: 36px; min-width: 36px; padding-right: 6px; }
        .highlight-layer, .code-textarea { padding: 12px; }
        .tab-name { max-width: 80px; }
    }
</style>