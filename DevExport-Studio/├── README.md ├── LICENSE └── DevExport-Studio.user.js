// ==UserScript==
// @name         DevExport Studio v9 - PDF + Word + ZIP + Código + Instalador
// @namespace    http://tampermonkey.net/
// @version      2026-10-16.9
// @description  Exporta proyectos de chats de IA: PDF real con estructura, Word (.rtf), ZIP con los archivos, manifest, instalador PowerShell y árbol del proyecto. Interfaz animada.
// @author       Izan
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://claude.ai/*
// @match        https://gemini.google.com/*
// @match        https://aistudio.google.com/*
// @match        https://grok.com/*
// @match        https://x.com/i/grok*
// @match        https://copilot.microsoft.com/*
// @match        https://chat.deepseek.com/*
// @match        https://www.perplexity.ai/*
// @match        https://chat.mistral.ai/*
// @match        https://poe.com/*
// @match        https://chat.qwen.ai/*
// @match        https://kimi.com/*
// @noframes
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    if (window.top !== window.self) return;
    if (document.getElementById('devexport-widget')) return;

    /* =====================================================
       1. UTILIDADES GENERALES
    ===================================================== */
    const EXT = 'html|htm|css|scss|js|jsx|mjs|cjs|ts|tsx|json|md|py|php|java|cs|cpp|c|h|sql|yml|yaml|env|txt|xml|vue|svg|bat|ps1|sh|ejs|pug|ini|toml|gitignore';
    const DOTFILES = 'env|gitignore|dockerignore|npmrc|prettierrc|eslintrc';
    const BLACKLIST = new Set(['node.js', 'express.js', 'vue.js', 'next.js', 'react.js', 'three.js',
        'chart.js', 'd3.js', 'nuxt.js', 'nest.js', 'p5.js', 'anime.js', 'alpine.js', 'socket.io',
        'process.env', 'import.meta.env']);

    // Nombre de archivo: "ruta/nombre.ext" o dotfile suelto (.env, .gitignore…)
    const FILE_PAT = '(?:[\\w\\-./@]+\\.(?:' + EXT + ')|\\.(?:' + DOTFILES + '))';

    const FIRST_RE = new RegExp(
        '^\\s*(?:\\/\\/|#|<!--|\\/\\*|--|;)\\s*(?:(?:archivo|file|filename|ruta|path)\\s*:\\s*)?' +
        '(' + FILE_PAT + ')\\s*(?:-->|\\*\\/)?\\s*$', 'i');
    const PREV_RE = new RegExp('(' + FILE_PAT + ')[\\s`"\'*:)\\]]*$', 'i');

    const stamp = () => Date.now();
    const pad2 = v => String(v).padStart(2, '0');
    const REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    function safePath(p) {
        return p.replace(/\\/g, '/').replace(/^[a-zA-Z]:/, '')
                .split('/').filter(s => s && s !== '.' && s !== '..').join('/');
    }

    function download(blob, name) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 30000); // margen para ZIP/PDF grandes
    }

    // Copiar al portapapeles con respaldo para webs que bloquean la API moderna
    function copyText(text) {
        const fallback = () => {
            // ta.select() destruye la selección y el foco de la página: los guardamos y restauramos
            const sel = window.getSelection();
            const ranges = [];
            for (let i = 0; i < sel.rangeCount; i++) ranges.push(sel.getRangeAt(i));
            const active = document.activeElement;
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;top:-1000px;opacity:0;';
            document.body.appendChild(ta);
            ta.select();
            let ok = false;
            try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
            document.body.removeChild(ta);
            sel.removeAllRanges();
            ranges.forEach(r => sel.addRange(r));
            if (active && typeof active.focus === 'function') {
                try { active.focus({ preventScroll: true }); } catch (e) { /* ignorar */ }
            }
            if (!ok) throw new Error('El navegador bloqueó el portapapeles.');
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text).catch(fallback);
        }
        try { fallback(); return Promise.resolve(); } catch (e) { return Promise.reject(e); }
    }

    /* =====================================================
       2. CAPTURA DE CONTENIDO (con limpieza de ruido de la web)
    ===================================================== */
    let host = null; // elemento del widget (se crea en la sección de interfaz)

    function getRoot() {
        return document.querySelector('main') || document.body;
    }

    const UI_NOISE = [
        /^\s*(Share|Compartir|Copy|Copiar|Retry|Reintentar|Edit|Editar|Regenerate|Regenerar)\s*$/i,
        /^\s*(javascript|js|html|css|json|python|powershell|bash|shell|sql|typescript|xml|yaml|markdown|text|plaintext)\s*$/i,
        /^\s*(Read|Updated|Read and updated)( and updated)? memory\s*$/i,
        /^Use the up and down arrow keys/i,
        /^Load earlier messages/i,
        /^\s*Skip to content\s*$/i
    ];

    // Solo emojis reales. \p{Extended_Pictographic} a secas también borraba © ® ™ ✔ ▶ ↔ del contenido.
    const EMOJI_RE = new RegExp('\\p{Extended_Pictographic}\\uFE0F|\\p{Emoji_Presentation}', 'gu');
    const INVISIBLE_RE = /[\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u206F\uFEFF\uE000-\uF8FF\uFE0F]/g;

    function cleanText(t) {
        const out = [];
        t.replace(/\r/g, '').split('\n').forEach(line => {
            const orig = line;
            line = line.replace(EMOJI_RE, '').replace(INVISIBLE_RE, '');
            if (orig.trim() && !line.trim()) return;                 // línea que solo era icono/emoji
            if (UI_NOISE.some(r => r.test(line))) return;            // botones y etiquetas de la interfaz
            line = line.replace(/^(Claude responded|You said|Dijiste|ChatGPT dijo|ChatGPT said):\s*/i, '');
            out.push(line.replace(/\s+$/, ''));
        });
        return out.join('\n').replace(/\n{3,}/g, '\n\n');
    }

    // <pre> del chat (o de la selección) con su código ya normalizado. Se calcula una vez por exportación.
    function scanPres() {
        const sel = window.getSelection();
        const hasSel = sel && sel.toString().trim().length > 0;
        let pres = [...getRoot().querySelectorAll('pre')].filter(p => !p.closest('#devexport-widget'));
        if (hasSel) pres = pres.filter(p => { try { return sel.containsNode(p, true); } catch (e) { return false; } });
        return pres.map(pre => {
            const codeEl = pre.querySelector('code') || pre;
            const code = (codeEl.innerText || '').replace(/\r/g, '').replace(/\u00a0/g, ' ').replace(/\s+$/, '');
            return { pre, codeEl, code };
        });
    }

    // Limpia solo la PROSA y conserva el código tal cual. Antes cleanText() también lo tocaba:
    // borraba líneas "text"/"json", colapsaba líneas en blanco y recortaba espacios (rompía Python/Markdown).
    function cleanKeepingCode(raw, scan) {
        raw = raw.replace(/\r/g, '').replace(/\u00a0/g, ' ');
        const parts = [];
        let cur = 0;
        scan.forEach(s => {
            if (!s.code.trim()) return;
            const i = raw.indexOf(s.code, cur);
            if (i < 0) return;                         // no localizado: se tratará como prosa
            parts.push(cleanText(raw.slice(cur, i)), s.code);
            cur = i + s.code.length;
        });
        parts.push(cleanText(raw.slice(cur)));
        return parts.join('');
    }

    function getText(scan) {
        scan = scan || scanPres();
        const sel = window.getSelection().toString();
        if (sel && sel.trim()) return cleanKeepingCode(sel, scan);
        // innerText sobre el nodo REAL (en un clon se pierden los saltos de línea)
        const root = getRoot();
        const hide = !!host && root.contains(host); // solo hay que ocultarlo si cuelga del root (sin <main>)
        if (hide) host.style.display = 'none';
        let t = '';
        try { t = root.innerText || root.textContent || ''; }
        finally { if (hide) host.style.display = ''; }
        return cleanKeepingCode(t, scan);
    }

    /* ---------- Árbol: detección estricta ---------- */
    const TREE_MARK = /^[\s│|]*[├└]──\s*(.*)$/;

    function isTreeLine(l) {
        const m = l.match(TREE_MARK);
        // El nombre no puede parecer código (;, {, }, =) ni ser larguísimo
        return !!m && m[1].length > 0 && m[1].length < 80 && !/[;{}=]/.test(m[1]);
    }

    function isTreeBlock(code) {
        const ls = code.split('\n').filter(l => l.trim());
        const n = ls.filter(isTreeLine).length;
        return n >= 2 && n / ls.length >= 0.6;
    }

    /* ---------- Bloques de código ---------- */
    function pathFromPrev(pre) {
        let el = pre;
        for (let level = 0; level < 4 && el; level++) {
            const prev = el.previousElementSibling;
            if (prev) {
                // Si lo anterior es otro bloque de código (o lo contiene), este bloque no tiene etiqueta
                // propia: evita pisar el archivo de otro bloque al heredar su nombre.
                if (prev.tagName === 'PRE' || prev.querySelector('pre')) return null;
                const t = (prev.innerText || '').trim();
                if (t && t.length < 200) {
                    const m = t.match(PREV_RE);
                    if (m && !BLACKLIST.has(m[1].toLowerCase())) return m[1];
                }
            }
            el = el.parentElement;
        }
        return null;
    }

    function guessExt(el, code) {
        const cls = (el.className || '') + ' ' + ((el.parentElement && el.parentElement.className) || '');
        const m = typeof cls === 'string' ? cls.match(/language-([\w+#-]+)/i) : null;
        const map = { javascript: '.js', js: '.js', html: '.html', css: '.css', json: '.json', python: '.py', py: '.py',
            powershell: '.ps1', bash: '.sh', shell: '.sh', sh: '.sh', sql: '.sql', typescript: '.ts', ts: '.ts',
            xml: '.xml', yaml: '.yml', yml: '.yml', markdown: '.md', md: '.md', jsx: '.jsx', tsx: '.tsx',
            java: '.java', php: '.php', bat: '.bat', batch: '.bat' };
        if (m && map[m[1].toLowerCase()]) return map[m[1].toLowerCase()];
        if (/^\s*<!doctype html|^\s*<html/i.test(code)) return '.html';
        return '.txt';
    }

    // Cada bloque: { name, data, src, versions[] }.
    //  src = por qué se eligió el nombre ("cabecera" | "texto previo" | "sin nombre")
    //  versions = todas las versiones que el chat dio de ese archivo (por defecto se exporta la última)
    function getBlocks(scan) {
        scan = scan || scanPres();
        const map = new Map();   // ruta -> [{data, src}]
        const unnamed = [];
        scan.forEach(({ pre, codeEl, code: code0 }) => {
            let code = code0;
            if (!code.trim()) return;
            if (isTreeBlock(code)) return; // es un árbol de carpetas, no código

            let path = null, src = '';
            const lines = code.split('\n');
            const m = lines[0].match(FIRST_RE);
            if (m) { path = m[1]; src = 'cabecera'; code = lines.slice(1).join('\n').replace(/^\n+/, ''); }
            if (!path) { path = pathFromPrev(pre); if (path) src = 'texto previo'; }

            if (path) {
                path = safePath(path);
                if (path) {
                    if (!map.has(path)) map.set(path, []);
                    map.get(path).push({ data: code, src });
                    return;
                }
            }
            unnamed.push({ name: '_sin-nombre/bloque-' + (unnamed.length + 1) + guessExt(codeEl, code), data: code,
                           src: 'sin nombre', versions: [{ data: code, src: 'sin nombre' }] });
        });
        const named = [...map].map(([name, vs]) => {
            const last = vs[vs.length - 1];
            return { name, data: last.data, src: last.src, versions: vs };
        });
        return { named, unnamed, all: [...named, ...unnamed] };
    }

    /* =====================================================
       3. ESTRUCTURA DEL PROYECTO (árbol)
    ===================================================== */
    function extractExistingTree(text) {
        const lines = text.split('\n');
        let best = null;
        for (let i = 0; i < lines.length; i++) {
            if (!isTreeLine(lines[i])) continue;
            let s = i;
            if (s > 0 && /^[\w\-.@]+\/$/.test(lines[s - 1].trim())) s--;   // línea raíz tipo "mi-proyecto/"
            let e = i;
            while (e + 1 < lines.length && isTreeLine(lines[e + 1])) e++;
            if (e - i >= 1) best = lines.slice(s, e + 1).map(l => l.replace(/\s+$/, '')).join('\n');
            i = e;
        }
        return best; // el último árbol válido del chat
    }

    function detectPaths(text) {
        const clean = text.replace(/https?:\/\/\S+/g, ' ');
        const re = new RegExp('(?:^|[\\s`"\'*#(\\[])((?:[\\w\\-.@]+\\/)*(?:[\\w\\-.@]+\\.(?:' + EXT + ')|\\.(?:' + DOTFILES + ')))(?=$|[\\s`"\'*:,;)\\]])', 'gim');
        const set = new Set();
        let m;
        while ((m = re.exec(clean)) !== null) {
            const p = safePath(m[1]);   // elimina "./", "../" y "/" iniciales (antes "../x.js" generaba una carpeta ".." en el árbol)
            if (!p) continue;
            if (BLACKLIST.has(p.toLowerCase())) continue;
            if (p.startsWith('proyecto/')) continue;
            if (/^\d/.test(p) && !p.includes('/')) continue;
            set.add(p);
        }
        return [...set].sort();
    }

    function buildTree(paths) {
        if (!paths.length) return null;
        // Objetos SIN prototipo: con {} una ruta como "__proto__/x.js" o "constructor/x.js"
        // escribía propiedades en Object.prototype / Object de la página (prototype pollution).
        const root = Object.create(null);
        paths.forEach(p => {
            let node = root;
            p.split('/').forEach(part => { node = node[part] || (node[part] = Object.create(null)); });
        });
        const lines = ['proyecto/'];
        (function walk(node, prefix) {
            const keys = Object.keys(node).sort((a, b) => {
                const da = Object.keys(node[a]).length > 0, db = Object.keys(node[b]).length > 0;
                if (da !== db) return da ? -1 : 1;
                return a.localeCompare(b);
            });
            keys.forEach((k, i) => {
                const last = i === keys.length - 1;
                const isDir = Object.keys(node[k]).length > 0;
                lines.push(prefix + (last ? '└── ' : '├── ') + k + (isDir ? '/' : ''));
                if (isDir) walk(node[k], prefix + (last ? '    ' : '│   '));
            });
        })(root, '');
        return lines.join('\n');
    }

    function getTree(text, blocks) {
        return extractExistingTree(text) ||
               buildTree(blocks.named.length ? blocks.named.map(b => b.name) : detectPaths(text));
    }

    function buildDocument() {
        const scan = scanPres();
        const blocks = getBlocks(scan);
        const text = getText(scan);
        return {
            title: (document.title || 'Proyecto').replace(/[^\p{L}\p{N}\s_-]/gu, '').trim() || 'Proyecto',
            date: new Date().toLocaleString('es-ES'),
            url: location.href,
            tree: getTree(text, blocks),
            text, blocks
        };
    }

    class Warn extends Error {}
    const needText = d => { if (!d.text.trim()) throw new Warn('No hay contenido para exportar.'); };
    const needBlocks = d => { if (!d.blocks.all.length) throw new Warn('No se detectaron bloques de código.'); };

    /* =====================================================
       3b. DETECTOR DE SECRETOS (heurístico: avisa, nunca bloquea)
    ===================================================== */
    // Todas las expresiones están acotadas ({0,30}, {20,}) para evitar backtracking cuadrático
    // con líneas enormes (base64, minificados).
    const GENERIC_SECRET_RE = /((?:password|passwd|pwd|secret|api[_-]?key|apikey|token|private[_-]?key)[A-Za-z0-9_-]{0,30}["']?\s*[:=]\s*["']?)([^\s"'`;,]{8,})/gi;
    const SECRET_RULES = [
        { label: 'clave AWS', re: /\bAKIA[0-9A-Z]{16}\b/g },
        { label: 'token de GitHub', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g },
        { label: 'clave API (sk-…)', re: /\bsk-[A-Za-z0-9_-]{20,}/g },
        { label: 'token de Slack', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
        { label: 'clave de Google', re: /\bAIza[0-9A-Za-z_-]{35}/g },
        { label: 'clave privada', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g },
        { label: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
        { label: 'credencial en asignación', re: GENERIC_SECRET_RE, group: 2 }
    ];
    const PLACEHOLDER_RE = /^(?:x+|\*+|\.+|\d+|your[_-].*|change[_-]?me|example.*|dummy.*|test.*|password|secret|token|null|undefined|true|false|none|process\.env.*|import\.meta.*|req\..*|os\.environ.*|os\.getenv.*|config\..*|env\..*|this\..*|self\..*)$/i;
    const isPlaceholder = v => PLACEHOLDER_RE.test(v) || /[()\[\]{}$<>]/.test(v);

    // Devuelve { code, found:[{label,line}] }. Con redact=true sustituye cada secreto por [REDACTED].
    function processSecrets(code, redact) {
        const found = [];
        SECRET_RULES.forEach(rule => {
            for (const m of code.matchAll(rule.re)) {
                if (found.length >= 100) return;
                if (rule.group && isPlaceholder(m[rule.group])) continue;
                found.push({ label: rule.label, line: code.slice(0, m.index).split('\n').length });
            }
        });
        if (!redact || !found.length) return { code, found };
        let out = code;
        SECRET_RULES.forEach(rule => {
            out = out.replace(rule.re, (...a) => {
                if (rule.group) return isPlaceholder(a[2]) ? a[0] : a[1] + '[REDACTED]';
                return '[REDACTED]';
            });
        });
        return { code: out, found };
    }

    const secretNote = (n, what) => n ? ` · aviso: ${n} ${what} con posibles secretos` : '';
    function docNote(d) {
        if (d.text.length > 3e6) return '';
        const n = processSecrets(d.text, false).found.length;
        return n ? ` · aviso: ${n} posibles secretos en el contenido` : '';
    }

    /* =====================================================
       4. PDF REAL (Header + Body + XRef + Trailer + %%EOF)
    ===================================================== */
    const CP1252 = { '€': 128, '‚': 130, '„': 132, '…': 133, '‘': 145, '’': 146, '“': 147, '”': 148, '•': 149, '–': 150, '—': 151, '™': 153 };
    const TREE_ASCII = { '├': '|', '└': '`', '│': '|', '─': '-' };
    // Courier estándar solo cubre WinAnsi: transliteramos lo más común en vez de dejar "?"
    const TRANSLIT = { '→': '->', '←': '<-', '⇒': '=>', '✓': 'v', '✔': 'v', '✗': 'x', '✘': 'x', '≤': '<=', '≥': '>=', '≠': '!=' };

    function toWinAnsi(str) {
        let out = '';
        for (const ch of Array.from(str)) {
            const c = ch.codePointAt(0);
            if (TREE_ASCII[ch]) out += TREE_ASCII[ch];
            else if (ch === '\t') out += '    ';
            else if (c === 10) out += '\n';
            else if (c < 32) out += '';
            else if (c < 128 || (c >= 160 && c <= 255)) out += ch;
            else if (CP1252[ch]) out += String.fromCharCode(CP1252[ch]);
            else if (TRANSLIT[ch]) out += TRANSLIT[ch];
            else out += '?';
        }
        return out;
    }

    const pdfEsc = s => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

    function makePDF(doc) {
        const MAXCH = 91, PER_PAGE = 64;
        const L = [];
        const push = (t, b) => {
            t = toWinAnsi(t);
            t.split('\n').forEach(seg => {
                if (seg.length === 0) { L.push({ t: '', b }); return; }
                let rest = seg;
                for (;;) {
                    if (rest === '') break;
                    if (rest.length <= MAXCH) { L.push({ t: rest, b }); break; }
                    let cut = rest.lastIndexOf(' ', MAXCH);
                    if (cut < MAXCH * 0.5) cut = MAXCH;
                    L.push({ t: rest.slice(0, cut), b });
                    rest = rest.slice(cut).replace(/^ /, '');
                }
            });
        };

        push(doc.title.toUpperCase(), true);
        push('Fecha: ' + doc.date, false);
        push('Origen: ' + doc.url, false);
        push('', false);
        push('=== ESTRUCTURA DEL PROYECTO ===', true);
        push('', false);
        push(doc.tree || '(No se detectaron archivos en el contenido)', false);
        push('', false);
        push('=== CONTENIDO ===', true);
        push('', false);
        push(doc.text, false);

        const pages = [];
        for (let i = 0; i < L.length; i += PER_PAGE) pages.push(L.slice(i, i + PER_PAGE));
        const n = pages.length;

        const now = new Date();
        const pdfDate = 'D:' + now.getFullYear() + pad2(now.getMonth() + 1) + pad2(now.getDate()) +
                        pad2(now.getHours()) + pad2(now.getMinutes()) + pad2(now.getSeconds());

        const bodies = {};
        bodies[1] = '<< /Type /Catalog /Pages 2 0 R >>';
        bodies[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${6 + 2 * i} 0 R`).join(' ')}] /Count ${n} >>`;
        bodies[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>';
        bodies[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>';
        bodies[5] = `<< /Title (${pdfEsc(toWinAnsi(doc.title))}) /Producer (DevExport Studio) /Creator (Tampermonkey) /CreationDate (${pdfDate}) >>`;

        pages.forEach((pg, i) => {
            const pageId = 6 + 2 * i, contId = 7 + 2 * i;
            let s = 'BT\n50 800 Td\n11.5 TL\n', cur = 0;
            pg.forEach(line => {
                const f = line.b ? 2 : 1;
                if (f !== cur) { s += `/F${f} 9 Tf\n`; cur = f; }   // solo cambia de fuente cuando hace falta
                s += `(${pdfEsc(line.t)}) Tj T*\n`;
            });
            s += 'ET\n';
            s += `BT\n/F1 8 Tf\n50 30 Td\n(Pagina ${i + 1} de ${n}) Tj\nET`;
            bodies[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contId} 0 R >>`;
            bodies[contId] = `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
        });

        const total = 5 + 2 * n;
        let out = '%PDF-1.7\n%\u00E2\u00E3\u00CF\u00D3\n';
        const offsets = [];
        for (let id = 1; id <= total; id++) {
            offsets[id] = out.length;
            out += `${id} 0 obj\n${bodies[id]}\nendobj\n`;
        }
        const xrefPos = out.length;
        out += `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
        for (let id = 1; id <= total; id++) out += String(offsets[id]).padStart(10, '0') + ' 00000 n \n';
        out += `trailer\n<< /Size ${total + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;

        const bytes = new Uint8Array(out.length);
        for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 255;
        return new Blob([bytes], { type: 'application/pdf' });
    }

    /* =====================================================
       5. WORD (.rtf)
    ===================================================== */
    function rtfEsc(str) {
        let out = '';
        for (let i = 0; i < str.length; i++) {
            const ch = str[i], c = str.charCodeAt(i);
            if (ch === '\\') out += '\\\\';
            else if (ch === '{') out += '\\{';
            else if (ch === '}') out += '\\}';
            else if (ch === '\n') out += '\\line\n';
            else if (ch === '\r') continue;
            else if (ch === '\t') out += '\\tab ';
            else if (c > 127) out += '\\u' + (c > 32767 ? c - 65536 : c) + '?';
            else out += ch;
        }
        return out;
    }

    function makeRTF(doc) {
        let r = '{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fnil\\fcharset0 Consolas;}}\n';
        r += '\\viewkind4\\uc1\\pard\\lang1034\\f0\\fs20 ';
        r += '\\b\\fs32 ' + rtfEsc(doc.title) + '\\b0\\fs20\\line\n';
        r += rtfEsc('Fecha: ' + doc.date) + '\\line\n' + rtfEsc('Origen: ' + doc.url) + '\\line\\line\n';
        r += '\\b\\fs26 ESTRUCTURA DEL PROYECTO\\b0\\fs20\\line\\line\n';
        r += rtfEsc(doc.tree || '(No se detectaron archivos en el contenido)') + '\\line\\line\n';
        r += '\\b\\fs26 CONTENIDO\\b0\\fs20\\line\\line\n';
        r += rtfEsc(doc.text) + '\n}';
        return new Blob([r], { type: 'application/rtf' });
    }

    /* =====================================================
       6. ZIP REAL (sin librerías, método "store")
    ===================================================== */
    const CRC_T = (() => {
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            t[n] = c >>> 0;
        }
        return t;
    })();

    function crc32(bytes) {
        let c = 0xFFFFFFFF;
        for (let i = 0; i < bytes.length; i++) c = CRC_T[(c ^ bytes[i]) & 255] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    function makeZip(files) {
        const enc = new TextEncoder();
        const u16 = n => [n & 255, (n >>> 8) & 255];
        const u32 = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
        const parts = [], central = [];
        let offset = 0;

        files.forEach(f => {
            const name = enc.encode(f.name), data = enc.encode(f.data), crc = crc32(data);
            const local = new Uint8Array([0x50, 0x4b, 3, 4, ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21),
                ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)]);
            parts.push(local, name, data);
            central.push(new Uint8Array([0x50, 0x4b, 1, 2, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21),
                ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0),
                ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), name);
            offset += local.length + name.length + data.length;
        });

        const cdSize = central.reduce((s, a) => s + a.length, 0);
        const end = new Uint8Array([0x50, 0x4b, 5, 6, ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
            ...u32(cdSize), ...u32(offset), ...u16(0)]);
        return new Blob([...parts, ...central, end], { type: 'application/zip' });
    }

    /* =====================================================
       7. MANIFEST + INSTALADOR POWERSHELL
    ===================================================== */
    function makeManifest(blocks) {
        return blocks.all.map(b => `=== FILE: ${b.name} ===\n${b.data}\n`).join('\n');
    }

    function toBase64(str) {
        const bytes = new TextEncoder().encode(str);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
        return btoa(bin);
    }

    // Una llamada Add-File por archivo: evita errores de PowerShell con comas finales
    // y con arrays de un solo elemento.
    function makePS1(blocks) {
        const q = s => "'" + s.replace(/'/g, "''") + "'";
        const L = [];
        L.push('# Instalador generado por DevExport Studio');
        L.push('# Crea la carpeta "proyecto" con todos los archivos del chat.');
        L.push('# Ejecutar: powershell -ExecutionPolicy Bypass -File .\\crear-proyecto.ps1');
        L.push("$ErrorActionPreference = 'Stop'");
        L.push("$out = Join-Path (Get-Location).Path 'proyecto'");
        L.push('function Add-File($rel, $b64) {');
        L.push('  $dest = Join-Path $out $rel');
        L.push('  New-Item -ItemType Directory -Force -Path (Split-Path $dest -Parent) | Out-Null');
        L.push('  [IO.File]::WriteAllBytes($dest, [Convert]::FromBase64String($b64))');
        L.push('  Write-Host ("Creado: " + $rel)');
        L.push('}');
        blocks.all.forEach(b => L.push('Add-File ' + q(b.name) + ' ' + q(toBase64(b.data))));
        L.push('Write-Host ("Listo -> " + $out)');
        return L.join('\r\n') + '\r\n';
    }

    /* =====================================================
       8. INTERFAZ ANIMADA (Shadow DOM + CSS puro)
          - Solo se animan transform y opacity (compositor, 60 fps)
          - Sin librerías externas (compatible con la CSP de las webs de IA)
          - Respeta "reducir movimiento" del sistema operativo
          - Los brillos infinitos solo corren con el ratón encima (ahorra GPU con backdrop-filter)
          Personalización rápida: variables --spring y --ease de .wrap,
          y los retardos (animation-delay) de .btn / .sec h4.
    ===================================================== */
    const CSS = `
:host{all:initial}
*{box-sizing:border-box;margin:0;padding:0}
.wrap{--spring:cubic-bezier(.34,1.56,.64,1);--ease:cubic-bezier(.22,1,.36,1);position:fixed;right:24px;bottom:24px;z-index:2147483647;display:flex;flex-direction:column;align-items:flex-end;gap:8px;font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#e2e8f0;font-size:12px;line-height:1.35}
button{font-family:inherit;cursor:pointer}

/* ---------- Keyframes ---------- */
@keyframes pop{from{opacity:0;transform:translateY(16px) scale(.9)}to{opacity:1;transform:none}}
@keyframes close{to{opacity:0;transform:translateY(12px) scale(.9)}}
@keyframes rise{from{opacity:0;transform:translateY(9px)}to{opacity:1;transform:none}}
@keyframes logopop{from{opacity:0;transform:scale(.4) rotate(-25deg)}to{opacity:1;transform:none}}
@keyframes sheen{0%,55%{transform:translateX(0) skewX(-20deg)}100%{transform:translateX(480%) skewX(-20deg)}}
@keyframes sweep{0%{transform:translateX(-100%)}55%,100%{transform:translateX(100%)}}
@keyframes ping{75%,100%{transform:scale(2.6);opacity:0}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes ripple{to{transform:scale(2.6);opacity:0}}
@keyframes okpop{0%{transform:scale(1)}40%{transform:scale(1.22)}100%{transform:scale(1)}}
@keyframes draw{to{stroke-dashoffset:0}}
@keyframes tick{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@keyframes toastin{from{opacity:0;transform:translateY(12px) scale(.94)}to{opacity:1;transform:none}}
@keyframes toastout{to{opacity:0;transform:translateY(8px) scale(.96)}}
@keyframes bar{from{transform:scaleX(1)}to{transform:scaleX(0)}}
@keyframes fabin{from{opacity:0;transform:scale(.4) rotate(-30deg)}to{opacity:1;transform:none}}
@keyframes halo{0%{transform:scale(1);opacity:.5}100%{transform:scale(1.75);opacity:0}}
@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(3px)}}

/* ---------- Panel ---------- */
.panel{position:relative;width:304px;max-width:calc(100vw - 16px);background:linear-gradient(180deg,rgba(30,41,59,.94),rgba(15,23,42,.97));-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);border:1px solid rgba(148,163,184,.22);border-radius:18px;box-shadow:0 22px 50px -14px rgba(0,0,0,.7),inset 0 1px 0 rgba(255,255,255,.06);overflow:hidden;transform-origin:100% 100%;animation:pop .36s var(--spring) backwards;transition:transform .18s var(--ease)}
.panel.closing{animation:close .17s ease-in forwards}
.panel::before{content:"";position:absolute;top:0;left:0;right:0;height:2px;z-index:2;background:linear-gradient(90deg,transparent,#818cf8,#c084fc,transparent);transform:translateX(-100%)}
.panel:hover::before{animation:sweep 3.6s ease-in-out infinite}
.wrap.dragging .panel{transform:scale(.985)}
.wrap.dragging .fab{transform:scale(1.12)}

/* ---------- Cabecera ---------- */
.head{display:flex;align-items:center;gap:9px;padding:12px 12px 10px;cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none}
.grip{color:#475569;display:flex;transition:color .2s}
.head:hover .grip{color:#94a3b8}
.logo{position:relative;overflow:hidden;width:30px;height:30px;border-radius:10px;display:grid;place-items:center;color:#fff;background:linear-gradient(135deg,#6366f1,#a855f7);box-shadow:0 6px 14px -4px rgba(99,102,241,.8);animation:logopop .55s var(--spring) .1s backwards}
.logo::after{content:"";position:absolute;top:-20%;bottom:-20%;left:-60%;width:50%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent);transform:skewX(-20deg)}
.panel:hover .logo::after{animation:sheen 4.5s ease-in-out infinite}
.titles{display:flex;flex-direction:column;flex:1;min-width:0;animation:rise .4s var(--ease) .14s backwards}
.title{font-size:13.5px;font-weight:700;color:#f8fafc;letter-spacing:.2px}
.sub{font-size:10.5px;color:#94a3b8}
.iconbtn{width:26px;height:26px;border-radius:8px;border:1px solid rgba(148,163,184,.18);background:rgba(148,163,184,.08);color:#cbd5e1;display:grid;place-items:center;transition:background .15s,transform .15s var(--spring)}
.iconbtn:hover{background:rgba(148,163,184,.2);transform:scale(1.08)}
.iconbtn:active{transform:scale(.92)}
.iconbtn svg{transition:transform .2s var(--ease)}
.iconbtn:hover svg{transform:translateY(2px)}

/* ---------- Estado ---------- */
.status{display:flex;align-items:center;gap:8px;margin:0 12px 12px;padding:8px 10px;border-radius:10px;background:rgba(99,102,241,.12);border:1px solid rgba(99,102,241,.28);color:#c7d2fe;font-size:11px;animation:rise .4s var(--ease) .18s backwards}
.stext{display:inline-block}
.stext.tick{animation:tick .35s var(--ease)}
.dot{position:relative;flex:none;width:7px;height:7px;border-radius:50%;background:#34d399;box-shadow:0 0 8px #34d399}
.dot::after{content:"";position:absolute;inset:0;border-radius:50%;background:inherit;animation:ping 1.8s cubic-bezier(0,0,.2,1) infinite}
.dot.warn{background:#fbbf24;box-shadow:0 0 8px #fbbf24}

/* ---------- Secciones y botones ---------- */
.sec{padding:0 12px 11px}
.sec h4{font-size:9.5px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#64748b;margin-bottom:6px;animation:rise .35s var(--ease) backwards;animation-delay:calc(var(--s,0) * 110ms + 200ms)}
.grid{display:grid;gap:6px}
.c2{grid-template-columns:repeat(2,1fr)}
.c3{grid-template-columns:repeat(3,1fr)}

.btn{position:relative;overflow:hidden;display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 4px 9px;border-radius:12px;border:1px solid rgba(148,163,184,.16);background:rgba(148,163,184,.07);color:#e2e8f0;font-size:11px;font-weight:600;transition:transform .18s var(--spring),background .18s,border-color .18s;animation:rise .42s var(--ease) backwards;animation-delay:calc(var(--i,0) * 45ms + 240ms)}
.btn>*{position:relative;z-index:1}
.btn::before{content:"";position:absolute;inset:0;z-index:0;background:radial-gradient(circle at 50% 0%,var(--c),transparent 72%);opacity:0;transition:opacity .25s}
.btn:hover{transform:translateY(-2px);background:rgba(148,163,184,.13);border-color:var(--c)}
.btn:hover::before{opacity:.24}
.btn:active{transform:translateY(0) scale(.96)}
.btn.busy{pointer-events:none;opacity:.85}
.ic{position:relative;width:30px;height:30px;border-radius:9px;display:grid;place-items:center;color:#fff;background:var(--c);transition:transform .28s var(--spring)}
.btn:hover .ic{transform:translateY(-1px) rotate(-6deg) scale(1.1)}
.ic.okflash{animation:okpop .45s var(--spring)}
.btn.busy .ic::after{content:"";position:absolute;inset:-4px;border-radius:12px;border:2px solid transparent;border-top-color:#fff;animation:spin .6s linear infinite}
.rip{position:absolute;z-index:0;border-radius:50%;background:var(--c);opacity:.38;pointer-events:none;transform:scale(0);animation:ripple .6s ease-out forwards}
.draw path{stroke-dasharray:1;stroke-dashoffset:1;animation:draw .38s ease-out .08s forwards}

.foot{display:flex;justify-content:space-between;gap:8px;padding:8px 12px 10px;border-top:1px solid rgba(148,163,184,.12);font-size:10px;color:#64748b;animation:rise .4s var(--ease) .6s backwards}

/* ---------- Botón flotante (minimizado) ---------- */
.fab{position:relative;width:50px;height:50px;border-radius:16px;border:1px solid rgba(255,255,255,.16);background:linear-gradient(135deg,#6366f1,#a855f7);color:#fff;display:none;place-items:center;box-shadow:0 12px 26px -8px rgba(99,102,241,.8);transition:transform .2s var(--spring);touch-action:none;animation:fabin .4s var(--spring) backwards}
.fab::before{content:"";position:absolute;inset:0;border-radius:inherit;background:linear-gradient(135deg,#6366f1,#a855f7);z-index:-1;animation:halo 2.4s ease-out infinite}
.fab:hover{transform:scale(1.08)}
.fab:active{transform:scale(.94)}
.fab:hover svg{animation:bob .6s ease-in-out infinite}

/* ---------- Avisos ---------- */
.toast{position:relative;overflow:hidden;display:none;align-items:center;gap:7px;max-width:304px;padding:8px 12px;border-radius:12px;font-size:11.5px;font-weight:600;box-shadow:0 12px 28px -10px rgba(0,0,0,.6)}
.toast.show{display:flex;animation:toastin .32s var(--spring)}
.toast.show.leave{animation:toastout .2s ease-in forwards}
.toast.show::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2px;background:currentColor;opacity:.55;transform-origin:left;animation:bar 2.8s linear forwards}
.toast.ok{background:#064e3b;border:1px solid #10b981;color:#a7f3d0}
.toast.warn{background:#451a03;border:1px solid #f59e0b;color:#fde68a}
.toast.err{background:#4c0519;border:1px solid #f43f5e;color:#fecdd3}

/* ---------- Vista previa (modal) ---------- */
@keyframes fadein{from{opacity:0}to{opacity:1}}
.overlay{--spring:cubic-bezier(.34,1.56,.64,1);--ease:cubic-bezier(.22,1,.36,1);position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(2,6,23,.62);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#e2e8f0;font-size:12px;line-height:1.35;animation:fadein .2s ease-out}
.modal{width:min(580px,100%);max-height:min(84vh,740px);display:flex;flex-direction:column;background:linear-gradient(180deg,#1e293b,#0f172a);border:1px solid rgba(148,163,184,.25);border-radius:18px;box-shadow:0 30px 70px -20px rgba(0,0,0,.8);overflow:hidden;animation:pop .3s var(--spring) backwards}
.mhead{display:flex;align-items:flex-start;gap:10px;padding:14px 16px;border-bottom:1px solid rgba(148,163,184,.14)}
.mtitles{flex:1;min-width:0}
.mtitles h3{font-size:14px;font-weight:700;color:#f8fafc}
.mtitles p{font-size:11px;color:#94a3b8;margin-top:2px}
.flist{overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:6px;min-height:80px}
.frow{display:grid;grid-template-columns:auto 1fr auto;gap:6px 10px;align-items:center;padding:8px 10px;border-radius:10px;border:1px solid rgba(148,163,184,.14);background:rgba(148,163,184,.06);transition:opacity .15s}
.frow.off{opacity:.45}
.meta{grid-column:2 / 4;display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:10.5px;color:#94a3b8}
.tag{padding:1px 7px;border-radius:6px;background:rgba(99,102,241,.2);color:#c7d2fe;font-size:10px}
.tag.sin{background:rgba(245,158,11,.2);color:#fde68a}
.alerts{grid-column:1 / 4;display:flex;flex-direction:column;gap:4px}
.alerts:empty{display:none}
.alert{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:8px;background:rgba(244,63,94,.12);border:1px solid rgba(244,63,94,.3);color:#fecdd3;font-size:10.5px}
.alert svg{flex:none}
input[type=text],select{min-width:0;padding:5px 8px;border-radius:8px;border:1px solid rgba(148,163,184,.25);background:rgba(15,23,42,.8);color:#e2e8f0;font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
input[type=checkbox]{width:15px;height:15px;accent-color:#818cf8;cursor:pointer}
.mopts{display:flex;flex-direction:column;gap:6px;padding:10px 16px;border-top:1px solid rgba(148,163,184,.14)}
.mopts label{display:flex;align-items:center;gap:8px;color:#cbd5e1;font-size:11px;cursor:pointer}
.mfoot{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid rgba(148,163,184,.14)}
.pbtn{padding:8px 16px;border-radius:10px;border:1px solid rgba(148,163,184,.25);background:rgba(148,163,184,.1);color:#e2e8f0;font-size:12px;font-weight:600;transition:transform .15s var(--spring),background .15s}
.pbtn:hover{background:rgba(148,163,184,.2);transform:translateY(-1px)}
.pbtn.primary{background:linear-gradient(135deg,#6366f1,#a855f7);border-color:transparent;color:#fff}
.pbtn:disabled{opacity:.45;cursor:not-allowed;transform:none}
input:focus-visible,select:focus-visible,.pbtn:focus-visible{outline:2px solid #a5b4fc;outline-offset:2px}

/* ---------- Accesibilidad ---------- */
.btn:focus-visible,.iconbtn:focus-visible,.fab:focus-visible{outline:2px solid #a5b4fc;outline-offset:2px}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation:none!important;transition:none!important}
  .draw path{stroke-dashoffset:0!important}
}
`;

    const NS = 'http://www.w3.org/2000/svg';
    const ICONS = {
        download: ['M12 3v12', 'M7 10l5 5 5-5', 'M5 21h14'],
        pdf: ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z', 'M14 2v4a2 2 0 0 0 2 2h4', 'M10 9H8', 'M16 13H8', 'M16 17H8'],
        word: ['M3 5l3.2 14L12 8l5.8 11L21 5'],
        zip: ['M21 8v13H3V8', 'M1 3h22v5H1z', 'M10 12h4'],
        list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
        terminal: ['M4 17l6-6-6-6', 'M12 19h8'],
        code: ['M16 18l6-6-6-6', 'M8 6l-6 6 6 6'],
        folder: ['M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'],
        copy: [{ r: [8, 8, 14, 14, 2] }, 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'],
        chevron: ['M6 9l6 6 6-6'],
        grip: ['M9 5h.01', 'M15 5h.01', 'M9 12h.01', 'M15 12h.01', 'M9 19h.01', 'M15 19h.01'],
        check: ['M20 6L9 17l-5-5'],
        close: ['M18 6L6 18', 'M6 6l12 12'],
        alert: ['M12 9v4', 'M12 17h.01', 'M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z']
    };

    function svg(name, size) {
        const s = document.createElementNS(NS, 'svg');
        s.setAttribute('viewBox', '0 0 24 24');
        s.setAttribute('width', size || 16);
        s.setAttribute('height', size || 16);
        s.setAttribute('fill', 'none');
        s.setAttribute('stroke', 'currentColor');
        s.setAttribute('stroke-width', '2');
        s.setAttribute('stroke-linecap', 'round');
        s.setAttribute('stroke-linejoin', 'round');
        if (name === 'check') s.setAttribute('class', 'draw'); // el check se "dibuja" al aparecer
        ICONS[name].forEach(d => {
            if (typeof d === 'string') {
                const p = document.createElementNS(NS, 'path');
                p.setAttribute('d', d);
                if (name === 'check') p.setAttribute('pathLength', '1');
                s.appendChild(p);
            } else {
                const [x, y, w, h, rx] = d.r;
                const r = document.createElementNS(NS, 'rect');
                r.setAttribute('x', x); r.setAttribute('y', y);
                r.setAttribute('width', w); r.setAttribute('height', h); r.setAttribute('rx', rx);
                s.appendChild(r);
            }
        });
        return s;
    }

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text) e.textContent = text;
        return e;
    }

    host = document.createElement('devexport-widget');
    host.id = 'devexport-widget';
    const shadow = host.attachShadow({ mode: 'open' });
    try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(CSS);
        shadow.adoptedStyleSheets = [sheet];
    } catch (e) {
        const st = document.createElement('style');
        st.textContent = CSS;
        shadow.appendChild(st);
    }

    const wrap = el('div', 'wrap');
    const toastEl = el('div', 'toast');
    const panel = el('div', 'panel');
    const fab = el('button', 'fab');
    fab.title = 'Abrir DevExport (Alt+Shift+D)';
    fab.appendChild(svg('download', 22));
    wrap.append(toastEl, panel, fab);
    shadow.appendChild(wrap);

    /* ---------- Cabecera ---------- */
    const head = el('div', 'head');
    const grip = el('span', 'grip'); grip.appendChild(svg('grip', 16));
    const logo = el('div', 'logo'); logo.appendChild(svg('download', 16));
    const titles = el('div', 'titles');
    titles.append(el('span', 'title', 'DevExport'), el('span', 'sub', 'Exporta tu proyecto de IA'));
    const minBtn = el('button', 'iconbtn');
    minBtn.title = 'Minimizar (Alt+Shift+D)';
    minBtn.appendChild(svg('chevron', 14));
    head.append(grip, logo, titles, minBtn);

    /* ---------- Estado ---------- */
    const status = el('div', 'status');
    status.setAttribute('role', 'status'); // los lectores de pantalla anuncian los cambios
    const dot = el('span', 'dot');
    const statusText = el('span', 'stext', 'Analizando el chat…');
    status.append(dot, statusText);

    panel.append(head, status);

    /* ---------- Avisos (toast) ---------- */
    let toastTimer, toastTimer2;
    function toast(msg, type) {
        type = type || 'ok';
        clearTimeout(toastTimer); clearTimeout(toastTimer2);
        toastEl.className = 'toast';
        void toastEl.offsetWidth; // reinicia las animaciones si ya había un aviso visible
        toastEl.className = 'toast show ' + type;
        toastEl.replaceChildren(svg(type === 'ok' ? 'check' : 'alert', 14), el('span', '', msg));
        toastTimer = setTimeout(() => {
            toastEl.classList.add('leave');
            toastTimer2 = setTimeout(() => { toastEl.className = 'toast'; }, 200);
        }, 2800);
    }

    /* ---------- Ripple al pulsar ---------- */
    function ripple(btn, e) {
        if (REDUCED) return;
        const r = btn.getBoundingClientRect();
        const d = Math.max(r.width, r.height) * 1.2;
        const x = e.detail ? e.clientX - r.left : r.width / 2;   // Enter/Espacio: desde el centro
        const y = e.detail ? e.clientY - r.top : r.height / 2;
        const s = el('span', 'rip');
        s.style.width = s.style.height = d + 'px';
        s.style.left = (x - d / 2) + 'px';
        s.style.top = (y - d / 2) + 'px';
        btn.appendChild(s);
        setTimeout(() => s.remove(), 700);
    }

    /* ---------- Acciones ---------- */
    function act(btn, ic, base, fn) {
        if (btn.classList.contains('busy')) return;
        btn.classList.add('busy');
        const minDelay = new Promise(r => setTimeout(r, REDUCED ? 0 : 260)); // el spinner se ve siempre un instante
        Promise.all([Promise.resolve().then(fn), minDelay])
            .then(([msg]) => {
                toast(msg, 'ok');
                clearTimeout(btn._t);
                ic.classList.add('okflash');
                ic.replaceChildren(svg('check', 18));
                btn._t = setTimeout(() => { ic.classList.remove('okflash'); ic.replaceChildren(base); }, 1300);
            })
            .catch(err => {
                if (err instanceof Warn) toast(err.message, 'warn');
                else { console.error('[DevExport]', err); toast('Error: ' + err.message, 'err'); }
            })
            .then(() => btn.classList.remove('busy'));
    }

    const withTree = d => (d.tree ? 'ESTRUCTURA DEL PROYECTO\n' + d.tree + '\n\n' : '') + d.text;

    const SECTIONS = [
        { name: 'Documento', cols: 'c2', items: [
            { label: 'PDF', icon: 'pdf', color: '#e11d48', tip: 'PDF real con estructura del proyecto', run: () => {
                const d = buildDocument(); needText(d);
                download(makePDF(d), `proyecto-ia-${stamp()}.pdf`);
                return 'PDF descargado' + docNote(d);
            } },
            { label: 'Word', icon: 'word', color: '#2563eb', tip: 'Word (.rtf) con estructura del proyecto', run: () => {
                const d = buildDocument(); needText(d);
                download(makeRTF(d), `proyecto-ia-${stamp()}.rtf`);
                return 'Word descargado' + docNote(d);
            } }
        ] },
        { name: 'Proyecto', cols: 'c3', items: [
            { label: 'ZIP', icon: 'zip', color: '#f59e0b', tip: 'ZIP con los archivos de código (vista previa: casillas, nombres, versiones, secretos)', run: () => {
                const d = buildDocument(); needBlocks(d);
                return choosePreview(d).then(r => {
                    const tree = r.changed ? buildTree(r.files.map(f => f.name)) : d.tree;
                    const files = r.files.map(f => ({ name: 'proyecto/' + f.name, data: f.data }));
                    if (tree) files.push({ name: 'proyecto/ESTRUCTURA.txt', data: tree + '\n' });
                    download(makeZip(files), `proyecto-ia-${stamp()}.zip`);
                    return `ZIP descargado (${r.files.length} archivos)` + secretNote(r.secretFiles, 'de ellos');
                });
            } },
            { label: 'Manifest', icon: 'list', color: '#0d9488', tip: 'manifest.txt con los bloques (=== FILE: ruta ===)', run: () => {
                const d = buildDocument(); needBlocks(d);
                return choosePreview(d).then(r => {
                    download(new Blob([makeManifest({ all: r.files })], { type: 'text/plain;charset=utf-8' }), 'manifest.txt');
                    return 'manifest.txt descargado' + secretNote(r.secretFiles, 'archivos');
                });
            } },
            { label: '.ps1', icon: 'terminal', color: '#0891b2', tip: 'Instalador PowerShell que crea carpetas y archivos', run: () => {
                const d = buildDocument(); needBlocks(d);
                return choosePreview(d).then(r => {
                    download(new Blob(['\uFEFF' + makePS1({ all: r.files })], { type: 'text/plain;charset=utf-8' }), 'crear-proyecto.ps1');
                    return 'crear-proyecto.ps1 descargado' + secretNote(r.secretFiles, 'archivos');
                });
            } }
        ] },
        { name: 'Texto', cols: 'c3', items: [
            { label: 'Código', icon: 'code', color: '#64748b', tip: 'Descargar todo como .txt', run: () => {
                const d = buildDocument(); needText(d);
                download(new Blob([withTree(d)], { type: 'text/plain;charset=utf-8' }), `codigo-proyecto-${stamp()}.txt`);
                return '.txt descargado' + docNote(d);
            } },
            { label: 'Árbol', icon: 'folder', color: '#7c3aed', tip: 'Copiar estructura del proyecto', run: () => {
                const d = buildDocument();
                if (!d.tree) throw new Warn('No se detectó ninguna estructura de archivos.');
                return copyText(d.tree).then(() => 'Estructura copiada');
            } },
            { label: 'Copiar', icon: 'copy', color: '#475569', tip: 'Copiar todo al portapapeles', run: () => {
                const d = buildDocument(); needText(d);
                return copyText(withTree(d)).then(() => 'Copiado al portapapeles' + docNote(d));
            } }
        ] }
    ];

    let btnIndex = 0;
    SECTIONS.forEach((sec, si) => {
        const box = el('div', 'sec');
        const h = el('h4', '', sec.name);
        h.style.setProperty('--s', si);
        box.appendChild(h);
        const grid = el('div', 'grid ' + sec.cols);
        sec.items.forEach(it => {
            const b = el('button', 'btn');
            b.title = it.tip;
            b.style.setProperty('--c', it.color);
            b.style.setProperty('--i', btnIndex++);
            const ic = el('span', 'ic');
            const base = svg(it.icon, 16);
            ic.appendChild(base);
            b.append(ic, el('span', '', it.label));
            // Evita que pulsar el botón borre la selección de texto de la página
            b.addEventListener('mousedown', e => e.preventDefault());
            b.addEventListener('click', e => { ripple(b, e); act(b, ic, base, it.run); });
            grid.appendChild(b);
        });
        box.appendChild(grid);
        panel.appendChild(box);
    });

    const foot = el('div', 'foot');
    foot.append(el('span', '', 'Selecciona texto para exportar solo eso'), el('span', '', 'v9'));
    panel.appendChild(foot);

    /* ---------- Estado en vivo ---------- */
    // Antes: getBlocks() (innerText de cada <pre> = layout forzado) en CADA cambio de selección y cada 5 s.
    // Ahora: una firma barata (nº de <pre> + longitud de su textContent + selección); solo se reanaliza si cambia.
    let lastSig = '';
    function refreshStatus(force) {
        const sel = window.getSelection().toString().trim();
        let sig = sel.length + ':' + sel.slice(0, 40);
        getRoot().querySelectorAll('pre').forEach(p => { sig += '|' + p.textContent.length; });
        if (!force && sig === lastSig) return;
        lastSig = sig;

        let b;
        try { b = getBlocks(); } catch (e) { b = { named: [], unnamed: [], all: [] }; }
        const n = b.all.length;
        const text = (sel ? 'Selección activa · ' : 'Chat completo · ') +
            n + (n === 1 ? ' bloque de código' : ' bloques de código') +
            (n ? ` (${b.named.length} con ruta)` : '');
        if (statusText.textContent !== text) {
            statusText.textContent = text;
            statusText.classList.remove('tick');
            void statusText.offsetWidth;
            statusText.classList.add('tick'); // microanimación al cambiar el texto
        }
        dot.className = 'dot' + (n ? '' : ' warn');
    }

    /* ---------- Posición, arrastre y minimizar ---------- */
    const KEY = 'devexport-ui';
    let ui = { right: 24, bottom: 24, collapsed: false, skipPreview: false, debug: false };
    try {
        const saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
        // localStorage pertenece al origen de la web: validamos tipos en vez de fiarnos del JSON
        if (Number.isFinite(saved.right)) ui.right = saved.right;
        if (Number.isFinite(saved.bottom)) ui.bottom = saved.bottom;
        ui.collapsed = saved.collapsed === true;
        ui.skipPreview = saved.skipPreview === true;
        ui.debug = saved.debug === true;
    } catch (e) { /* sin almacenamiento o JSON corrupto: valores por defecto */ }
    const save = () => { try { localStorage.setItem(KEY, JSON.stringify(ui)); } catch (e) { /* ignorar */ } };

    /* =====================================================
       9. VISTA PREVIA: casillas, renombrar, elegir versión, avisos de secretos, depuración
    ===================================================== */
    const lineCount = str => str ? str.split('\n').length : 0;
    const fmtSize = str => { const n = new Blob([str]).size; return n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB'; };
    const secretsOf = it => it.cache[it.vi] || (it.cache[it.vi] = processSecrets(it.versions[it.vi].data, false).found);

    // Aplica las decisiones: filtra, sanea nombres, evita duplicados (también por mayúsculas) y redacta si procede
    function finalizeItems(items, redact) {
        const used = new Set(), files = [];
        let secretFiles = 0, changed = false;
        items.forEach(it => {
            if (!it.on) { changed = true; return; }
            let name = safePath(it.name) || it.orig;
            if (used.has(name.toLowerCase())) {
                const dot = name.lastIndexOf('.'), slash = name.lastIndexOf('/');
                let n = 2, cand;
                do { cand = dot > slash + 1 ? name.slice(0, dot) + '-' + n + name.slice(dot) : name + '-' + n; n++; }
                while (used.has(cand.toLowerCase()));
                name = cand;
            }
            used.add(name.toLowerCase());
            if (name !== it.orig) changed = true;
            let data = it.versions[it.vi].data;
            if (redact) data = processSecrets(data, true).code;
            else if (secretsOf(it).length) secretFiles++;
            files.push({ name, data });
        });
        return { files, secretFiles, changed };
    }

    function checkOpt(label, checked, onChange) {
        const lab = el('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = checked;
        input.addEventListener('change', () => onChange(input.checked));
        lab.append(input, el('span', '', label));
        return { wrap: lab, input };
    }

    function choosePreview(d) {
        const items = d.blocks.all.map(b => ({
            orig: b.name, name: b.name, versions: b.versions, vi: b.versions.length - 1,
            on: true, src: b.src, cache: []
        }));
        const needsReview = items.some(it => it.src === 'sin nombre' || it.versions.length > 1 || secretsOf(it).length);
        if (ui.debug) {
            console.groupCollapsed('[DevExport] vista previa');
            console.table(items.map(it => ({ archivo: it.name, origen: it.src, versiones: it.versions.length,
                lineas: lineCount(it.versions[it.vi].data), secretos: secretsOf(it).length })));
            console.log('árbol:', d.tree);
            console.groupEnd();
        }
        if (ui.skipPreview && !needsReview) return Promise.resolve(finalizeItems(items, false));

        return new Promise((resolve, reject) => {
            const prevFocus = document.activeElement;
            const overlay = el('div', 'overlay');
            const modal = el('div', 'modal');
            modal.setAttribute('role', 'dialog');
            modal.setAttribute('aria-modal', 'true');
            modal.setAttribute('aria-label', 'Vista previa de la exportación');

            const mhead = el('div', 'mhead');
            const mt = el('div', 'mtitles');
            mt.append(el('h3', '', 'Revisa lo que se va a exportar'),
                      el('p', '', 'Marca, renombra o elige versión. Los avisos son heurísticos: revísalos antes de compartir.'));
            const xBtn = el('button', 'iconbtn');
            xBtn.title = 'Cancelar (Esc)';
            xBtn.setAttribute('aria-label', 'Cancelar');
            xBtn.appendChild(svg('close', 14));
            mhead.append(mt, xBtn);

            const cancelBtn = el('button', 'pbtn', 'Cancelar');
            const okBtn = el('button', 'pbtn primary', 'Exportar');
            const redactOpt = checkOpt('Redactar los secretos detectados (se sustituyen por [REDACTED])', false, () => {});
            const skipOpt = checkOpt('No mostrar esta vista previa cuando no haya avisos', ui.skipPreview, v => { ui.skipPreview = v; save(); });
            const dbgOpt = checkOpt('Modo depuración (detalles en la consola)', ui.debug, v => { ui.debug = v; save(); });

            const refreshGlobal = () => {
                const n = items.filter(it => it.on).length;
                okBtn.textContent = `Exportar (${n})`;
                okBtn.disabled = n === 0;
                redactOpt.wrap.style.display = items.some(it => it.on && secretsOf(it).length) ? 'flex' : 'none';
            };

            const list = el('div', 'flist');
            let firstCb = null;
            items.forEach(it => {
                const row = el('div', 'frow');
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = true;
                cb.setAttribute('aria-label', 'Incluir ' + it.orig);
                const nm = document.createElement('input');
                nm.type = 'text';
                nm.value = it.name;
                nm.spellcheck = false;
                nm.setAttribute('aria-label', 'Nombre del archivo');
                row.append(cb, nm);
                if (!firstCb) firstCb = cb;

                let sel = null;
                if (it.versions.length > 1) {
                    sel = document.createElement('select');
                    sel.setAttribute('aria-label', 'Versión del archivo');
                    it.versions.forEach((v, i) => {
                        const o = document.createElement('option');
                        o.value = String(i);
                        o.textContent = `v${i + 1}/${it.versions.length} · ${lineCount(v.data)} líneas`;
                        sel.appendChild(o);
                    });
                    sel.value = String(it.vi);
                    row.appendChild(sel);
                } else {
                    row.appendChild(el('span'));
                }

                const meta = el('div', 'meta');
                const alerts = el('div', 'alerts');
                row.append(meta, alerts);

                const paint = () => {
                    const v = it.versions[it.vi];
                    meta.replaceChildren(
                        el('span', 'tag' + (it.src === 'sin nombre' ? ' sin' : ''), 'origen: ' + it.src),
                        el('span', '', lineCount(v.data) + ' líneas · ' + fmtSize(v.data)));
                    const sc = secretsOf(it);
                    const nodes = sc.slice(0, 4).map(x => {
                        const a = el('div', 'alert');
                        a.append(svg('alert', 12), el('span', '', `Posible secreto: ${x.label} (línea ${x.line})`));
                        return a;
                    });
                    if (sc.length > 4) nodes.push(el('div', 'alert', `… y ${sc.length - 4} más`));
                    alerts.replaceChildren(...nodes);
                    row.classList.toggle('off', !it.on);
                };
                cb.addEventListener('change', () => { it.on = cb.checked; paint(); refreshGlobal(); });
                nm.addEventListener('input', () => { it.name = nm.value; });
                if (sel) sel.addEventListener('change', () => { it.vi = Number(sel.value); paint(); refreshGlobal(); });
                paint();
                list.appendChild(row);
            });

            const opts = el('div', 'mopts');
            opts.append(redactOpt.wrap, skipOpt.wrap, dbgOpt.wrap);
            const mfoot = el('div', 'mfoot');
            mfoot.append(cancelBtn, okBtn);
            modal.append(mhead, list, opts, mfoot);
            overlay.appendChild(modal);

            const close = () => {
                overlay.remove();
                if (prevFocus && typeof prevFocus.focus === 'function') {
                    try { prevFocus.focus({ preventScroll: true }); } catch (e) { /* ignorar */ }
                }
            };
            const cancel = () => { close(); reject(new Warn('Exportación cancelada')); };
            const accept = () => {
                const redact = redactOpt.input.checked && items.some(it => it.on && secretsOf(it).length);
                const res = finalizeItems(items, redact);
                close();
                if (!res.files.length) reject(new Warn('No hay archivos seleccionados.'));
                else resolve(res);
            };
            xBtn.addEventListener('click', cancel);
            cancelBtn.addEventListener('click', cancel);
            okBtn.addEventListener('click', accept);

            // El teclado no sale del modal (las webs de IA tienen atajos globales) y el foco queda atrapado dentro
            ['keyup', 'keypress'].forEach(t => overlay.addEventListener(t, e => e.stopPropagation()));
            overlay.addEventListener('keydown', e => {
                e.stopPropagation();
                if (e.key === 'Escape') { e.preventDefault(); cancel(); return; }
                if (e.key !== 'Tab') return;
                const f = [...modal.querySelectorAll('input,select,button')].filter(x => !x.disabled && x.offsetParent !== null);
                if (!f.length) return;
                const first = f[0], last = f[f.length - 1], cur = shadow.activeElement;
                if (e.shiftKey && cur === first) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && cur === last) { e.preventDefault(); first.focus(); }
            });

            refreshGlobal();
            shadow.appendChild(overlay);
            (firstCb || okBtn).focus();
        });
    }

    function setPos(right, bottom) {
        // offsetWidth/Height ignoran las transformaciones; getBoundingClientRect devolvía un tamaño
        // reducido (scale .9) durante la animación de apertura y el panel podía salirse de la pantalla.
        const maxR = Math.max(8, window.innerWidth - wrap.offsetWidth - 8);
        const maxB = Math.max(8, window.innerHeight - wrap.offsetHeight - 8);
        ui.right = Math.min(Math.max(8, right), maxR);
        ui.bottom = Math.min(Math.max(8, bottom), maxB);
        wrap.style.right = ui.right + 'px';
        wrap.style.bottom = ui.bottom + 'px';
    }

    let suppressClick = false;
    function makeDraggable(handle) {
        let down = false, moving = false, sx = 0, sy = 0, sr = 0, sb = 0;
        handle.addEventListener('pointerdown', e => {
            if (e.button !== 0 || (e.target.closest && e.target.closest('.iconbtn'))) return;
            e.preventDefault();
            down = true; moving = false;
            sx = e.clientX; sy = e.clientY; sr = ui.right; sb = ui.bottom;
            try { handle.setPointerCapture(e.pointerId); } catch (_) { /* ignorar */ }
        });
        handle.addEventListener('pointermove', e => {
            if (!down) return;
            const dx = e.clientX - sx, dy = e.clientY - sy;
            if (!moving && Math.hypot(dx, dy) < 4) return;
            if (!moving) { moving = true; wrap.classList.add('dragging'); handle.style.cursor = 'grabbing'; }
            setPos(sr - dx, sb - dy);
        });
        const end = e => {
            if (!down) return;
            down = false;
            handle.style.cursor = '';
            wrap.classList.remove('dragging');
            if (moving) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); save(); }
            try { handle.releasePointerCapture(e.pointerId); } catch (_) { /* ignorar */ }
        };
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
    }
    makeDraggable(head);
    makeDraggable(fab);

    // Minimizar con animación de salida; abrir con animación de entrada (CSS al pasar de display:none a block)
    let collTimer;
    function setCollapsed(v, instant) {
        clearTimeout(collTimer);
        ui.collapsed = v;
        save();
        if (v) {
            const finish = () => {
                panel.classList.remove('closing');
                panel.style.display = 'none';
                fab.style.display = 'grid';
                setPos(ui.right, ui.bottom);
            };
            if (instant || REDUCED) { finish(); return; }
            panel.classList.add('closing');
            collTimer = setTimeout(finish, 170);
        } else {
            panel.classList.remove('closing');
            fab.style.display = 'none';
            panel.style.display = 'block';
            setPos(ui.right, ui.bottom);
            refreshStatus(true);
        }
    }

    minBtn.addEventListener('mousedown', e => e.preventDefault());
    minBtn.addEventListener('click', () => setCollapsed(true));
    fab.addEventListener('click', () => { if (!suppressClick) setCollapsed(false); });

    document.addEventListener('keydown', e => {
        if (!e.repeat && e.altKey && e.shiftKey && e.code === 'KeyD') { e.preventDefault(); setCollapsed(!ui.collapsed); }
    });
    window.addEventListener('resize', () => setPos(ui.right, ui.bottom));

    // Actualiza el contador mientras el panel está abierto
    let selTimer;
    document.addEventListener('selectionchange', () => {
        clearTimeout(selTimer);
        selTimer = setTimeout(() => { if (!ui.collapsed) refreshStatus(); }, 500);
    });
    setInterval(() => { if (!ui.collapsed && !document.hidden) refreshStatus(); }, 5000);

    /* ---------- Montaje ---------- */
    document.body.appendChild(host);
    setCollapsed(ui.collapsed, true);

    // Algunas webs (SPA) re-renderizan el body: nos aseguramos de que el widget siga ahí
    setInterval(() => {
        if (document.body && !host.isConnected) document.body.appendChild(host);
    }, 3000);
})();
