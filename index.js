/*
 * Alternate Universe — SillyTavern UI extension
 *
 * Switching presets mid-chat is messy: every preset makes the model write its
 * own tags, status blocks and chain-of-thought, and only that preset's regex
 * scripts know how to hide them. The text stored in the chat keeps all of it,
 * so the next preset sees (and imitates) the old preset's markup.
 *
 * This extension branches the chat and cleans the branch, leaving the original
 * untouched:
 *   • bakes the prompt-only regex scripts that are active right now into the
 *     stored text, so the branch holds exactly what the current preset sends
 *   • removes reasoning (parsed extra.reasoning and inline <think> blocks)
 *   • removes or unwraps extra tags, per preset (preset.extensions.alternateUniverse)
 * then optionally switches to another preset, and points the chat-level preset
 * locks the branch copied from its parent (Preset Formatting, Character Locks)
 * at that preset so they do not switch back.
 */

const MODULE = 'alternate_universe';
const FIELD = 'alternateUniverse';
const LOG = '[AlternateUniverse]';
const TITLE = 'Alternate Universe';
const VERSION = '1.2.0'; // keep in sync with manifest.json
const MENU_ID = 'option_alternate_universe';

const DEFAULTS = Object.freeze({
    ignoreDepth: true,
    stripReasoning: true,
    removeTags: '',
    unwrapTags: '',
    stripComments: true,
    collapseBlank: true,
    includeUser: true,
    swipes: 'all',
    rememberPerPreset: true,
    lockBranch: true,
    uncheckedScripts: [],
});

/** regex_placement values from the Regex extension. */
const PLACEMENT = Object.freeze({ USER_INPUT: 1, AI_OUTPUT: 2, REASONING: 6 });

/** Fields SillyTavern keeps next to extra.reasoning. */
const REASONING_FIELDS = ['reasoning', 'reasoning_duration', 'reasoning_type', 'reasoning_signature', 'reasoning_display_text'];

/** Reasoning wrappers removed even when the active template uses other ones. */
const COMMON_REASONING_PAIRS = [['<think>', '</think>'], ['<thinking>', '</thinking>']];

// ---------------------------------------------------------------- helpers

const ctx = () => SillyTavern.getContext();
const $id = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function settings() {
    const ext = ctx().extensionSettings;
    if (!ext[MODULE]) ext[MODULE] = {};
    const s = ext[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = Array.isArray(v) ? [...v] : v;
    }
    return s;
}

const save = () => ctx().saveSettingsDebounced();

const toast = {
    info: m => globalThis.toastr?.info(m, TITLE),
    ok: m => globalThis.toastr?.success(m, TITLE),
    warn: m => globalThis.toastr?.warning(m, TITLE),
    error: m => globalThis.toastr?.error(m, TITLE),
};

function debounce(fn, ms) {
    let t = null;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** "a, b\nc" → ['a', 'b', 'c'] with any < / > typed around the names dropped. */
const parseTagList = text => [...new Set(String(text ?? '')
    .split(/[\s,]+/)
    .map(x => x.replace(/^<\/?|\/?>$/g, '').trim())
    .filter(Boolean))];

/** Plain HTML that stories use for formatting; not worth offering for removal. */
const HTML_TAGS = new Set(('a abbr b blockquote br center code col colgroup dd del details div dl dt em font h1 h2 h3 h4 h5 h6 hr '
    + 'i img ins kbd li mark ol p pre q s small span strike strong style sub summary sup table tbody td tfoot th thead tr u ul').split(' '));

/** Non-HTML tag names left in the messages, most frequent first. */
function leftoverTags(chat) {
    const counts = new Map();
    const scan = text => {
        if (typeof text !== 'string') return;
        for (const m of text.matchAll(/<([A-Za-z][\w:.-]*)[^>]*>/g)) {
            const name = m[1].toLowerCase();
            if (!HTML_TAGS.has(name)) counts.set(name, (counts.get(name) ?? 0) + 1);
        }
    };
    for (const msg of chat) {
        scan(msg?.mes);
        if (msg?.extra?.reasoning) scan(msg.extra.reasoning);
    }
    return [...counts].sort((a, b) => b[1] - a[1]);
}

const presetManager = () => ctx().getPresetManager?.() ?? null;
const currentPresetName = () => presetManager()?.getSelectedPresetName?.() || '';

/** Preset Formatting 1.4+ can lock a chat to a preset (chat_metadata.presetFormatting.lockedPreset). */
const PF_FIELD = 'presetFormatting';
const hasPresetLock = () => typeof globalThis.PresetFormatting?.getChatLock === 'function';

/**
 * A branch copies its parent's chat_metadata, including any chat-level preset lock. Left alone, that
 * lock switches straight back to the old preset on every chat reload, and with two locks fighting the
 * chat reloads over and over. Point them at the preset the branch is for.
 * @param {object} meta branch chat_metadata
 * @param {string} target preset the branch switches to
 * @param {boolean} lock lock the branch to it with Preset Formatting (otherwise drop that lock)
 */
function relockBranch(meta, target, lock) {
    const pf = meta[PF_FIELD];
    if (lock) {
        meta[PF_FIELD] = { ...(pf && typeof pf === 'object' ? pf : {}), lockedPreset: target };
    } else if (pf?.lockedPreset) {
        delete pf.lockedPreset;
        if (!Object.keys(pf).length) delete meta[PF_FIELD];
    }
    // Character Locks (STCL) keeps a preset + connection profile pair per chat: keep the connection.
    const stcl = meta.STCL;
    if (stcl && typeof stcl === 'object' && stcl.preset) {
        meta.STCL = { ...stcl, preset: target, savedAt: new Date().toISOString() };
    }
}

/** Resolves true when `event` fires within `ms`, false otherwise. */
function waitForEvent(event, ms) {
    const { eventSource } = ctx();
    return new Promise(resolve => {
        const done = fired => {
            clearTimeout(timer);
            eventSource.removeListener(event, onEvent);
            resolve(fired);
        };
        const onEvent = () => done(true);
        const timer = setTimeout(() => done(false), ms);
        eventSource.on(event, onEvent);
    });
}

// ---------------------------------------------------------------- regex engine

let engine = null;

async function loadEngine() {
    try {
        // Third-party extensions live in scripts/extensions/third-party/<name>/
        engine = await import('../../regex/engine.js');
    } catch (e) {
        console.warn(LOG, 'Regex engine is not available; regex scripts will not be baked', e);
    }
}

/**
 * Prompt-only regex scripts that are switched on right now, in the order
 * SillyTavern runs them (global, preset, character).
 * @returns {{key: string, group: string, script: object}[]}
 */
function activePromptScripts() {
    if (!engine?.runRegexScript) return [];
    if (ctx().extensionSettings.disabledExtensions?.includes('regex')) return [];

    const T = engine.SCRIPT_TYPES;
    let groups;
    if (T && typeof engine.getScriptsByType === 'function') {
        const preset = currentPresetName();
        groups = [
            ['global', 'Global', engine.getScriptsByType(T.GLOBAL, { allowedOnly: true })],
            ['preset', preset ? `Preset: ${preset}` : 'Preset', engine.getScriptsByType(T.PRESET, { allowedOnly: true })],
            ['scoped', 'การ์ดตัวละคร', engine.getScriptsByType(T.SCOPED, { allowedOnly: true })],
        ];
    } else {
        groups = [['regex', 'Regex', engine.getRegexScripts?.() ?? []]];
    }

    const out = [];
    for (const [kind, group, scripts] of groups) {
        for (const script of Array.isArray(scripts) ? scripts : []) {
            if (!script || script.disabled || !script.promptOnly || !script.findRegex) continue;
            const placement = Array.isArray(script.placement) ? script.placement : [];
            if (!Object.values(PLACEMENT).some(p => placement.includes(p))) continue;
            out.push({ key: `${kind}:${script.id ?? script.scriptName}`, group, script });
        }
    }
    return out;
}

/** Same depth window check the Regex extension does. */
function depthAllows(script, depth) {
    if (typeof depth !== 'number') return true;
    const min = script.minDepth;
    const max = script.maxDepth;
    if (min !== null && min !== undefined && !isNaN(min) && min >= -1 && depth < min) return false;
    if (max !== null && max !== undefined && !isNaN(max) && max >= 0 && depth > max) return false;
    return true;
}

// ---------------------------------------------------------------- cleaning

/**
 * @typedef {object} CleanPlan
 * @property {object[]} scripts regex scripts to bake, in run order
 * @property {boolean} ignoreDepth
 * @property {boolean} stripReasoning
 * @property {RegExp[]} reasoningRes
 * @property {RegExp|null} removeRe
 * @property {RegExp|null} unwrapRe
 * @property {boolean} stripComments
 * @property {boolean} collapseBlank
 * @property {boolean} includeUser
 * @property {'all'|'current'} swipes
 */

function reasoningPatterns() {
    const pairs = [...COMMON_REASONING_PAIRS];
    const r = ctx().powerUserSettings?.reasoning;
    if (r?.prefix?.trim() && r?.suffix?.trim()) pairs.unshift([r.prefix.trim(), r.suffix.trim()]);
    const seen = new Set();
    return pairs
        .filter(([a, b]) => !seen.has(a + b) && seen.add(a + b))
        .map(([a, b]) => new RegExp(`${escRe(a)}[\\s\\S]*?${escRe(b)}`, 'gi'));
}

function tagBlockRe(tags) {
    if (!tags.length) return null;
    const names = tags.map(escRe).join('|');
    // <tag ...>...</tag> (lazy, so nested same-name tags close early) or a self-closing <tag/>
    return new RegExp(`<(${names})(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1\\s*>|<(?:${names})(?:\\s[^>]*)?\\/>`, 'gi');
}

function tagOnlyRe(tags) {
    if (!tags.length) return null;
    return new RegExp(`<\\/?(?:${tags.map(escRe).join('|')})(?:\\s[^>]*)?\\/?>`, 'gi');
}

/** @param {object} opts @param {object[]} scripts @returns {CleanPlan} */
function buildPlan(opts, scripts) {
    return {
        scripts,
        ignoreDepth: !!opts.ignoreDepth,
        stripReasoning: !!opts.stripReasoning,
        reasoningRes: opts.stripReasoning ? reasoningPatterns() : [],
        removeRe: tagBlockRe(parseTagList(opts.removeTags)),
        unwrapRe: tagOnlyRe(parseTagList(opts.unwrapTags)),
        stripComments: !!opts.stripComments,
        collapseBlank: !!opts.collapseBlank,
        includeUser: !!opts.includeUser,
        swipes: opts.swipes === 'current' ? 'current' : 'all',
    };
}

function bake(text, placement, depth, plan) {
    let out = text;
    for (const script of plan.scripts) {
        if (!script.placement?.includes(placement)) continue;
        if (!plan.ignoreDepth && !depthAllows(script, depth)) continue;
        try {
            out = engine.runRegexScript(script, out);
        } catch (e) {
            console.warn(LOG, `Regex script "${script.scriptName}" failed`, e);
        }
    }
    return out;
}

/** @returns {string} */
function cleanText(text, placement, depth, plan) {
    if (typeof text !== 'string' || !text) return text;
    let out = text;
    for (const re of plan.reasoningRes) out = out.replace(re, '');
    out = bake(out, placement, depth, plan);
    if (plan.removeRe) out = out.replace(plan.removeRe, '');
    if (plan.unwrapRe) out = out.replace(plan.unwrapRe, '');
    if (plan.stripComments) out = out.replace(/<!--[\s\S]*?-->/g, '');
    // Only tidy whitespace where something was taken out, so untouched messages stay byte-identical
    if (plan.collapseBlank && out !== text) out = out.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
    return out;
}

/** @returns {{changed: boolean, reasoning: number}} */
function cleanExtra(extra, depth, plan) {
    const res = { changed: false, reasoning: 0 };
    if (!extra || typeof extra !== 'object') return res;
    if (plan.stripReasoning) {
        if (extra.reasoning) res.reasoning++;
        for (const f of REASONING_FIELDS) {
            if (f in extra) { delete extra[f]; res.changed = true; }
        }
    } else if (typeof extra.reasoning === 'string' && extra.reasoning) {
        const r = cleanText(extra.reasoning, PLACEMENT.REASONING, depth, plan);
        if (r !== extra.reasoning) { extra.reasoning = r; res.changed = true; }
    }
    return res;
}

/**
 * Cleans one chat message in place.
 * @returns {{changed: boolean, reasoning: number}}
 */
function cleanMessage(msg, depth, plan) {
    const res = { changed: false, reasoning: 0 };
    if (!msg || typeof msg !== 'object') return res;
    if (msg.is_user && !plan.includeUser) return res;
    const placement = msg.is_user ? PLACEMENT.USER_INPUT : PLACEMENT.AI_OUTPUT;
    const add = r => { res.changed ||= r.changed; res.reasoning += r.reasoning; };

    if (Array.isArray(msg.swipes) && msg.swipes.length) {
        if (plan.swipes === 'current' && msg.swipes.length > 1) {
            const id = Math.min(Math.max(Number(msg.swipe_id) || 0, 0), msg.swipes.length - 1);
            msg.swipes = [msg.swipes[id]];
            msg.swipe_info = Array.isArray(msg.swipe_info) && msg.swipe_info[id] ? [msg.swipe_info[id]] : [];
            msg.swipe_id = 0;
            res.changed = true;
        }
        msg.swipes = msg.swipes.map(s => {
            const c = cleanText(s, placement, depth, plan);
            if (c !== s) res.changed = true;
            return c;
        });
        const current = Number(msg.swipe_id) || 0;
        (Array.isArray(msg.swipe_info) ? msg.swipe_info : []).forEach((info, i) => {
            // The selected swipe's reasoning is counted once, through msg.extra below
            const r = cleanExtra(info?.extra, depth, plan);
            add(i === current ? { ...r, reasoning: 0 } : r);
        });
    }

    const mes = cleanText(msg.mes, placement, depth, plan);
    if (mes !== msg.mes) { msg.mes = mes; res.changed = true; }
    add(cleanExtra(msg.extra, depth, plan));
    return res;
}

/** Depth of each message as the prompt builder counts it (system messages are not sent). */
function messageDepths(chat) {
    const core = chat.filter(m => !m?.is_system).length;
    let i = 0;
    return chat.map(m => (m?.is_system ? null : core - (i++) - 1));
}

/** @returns {{changed: number, reasoning: number}} */
function cleanChat(chat, plan) {
    const depths = messageDepths(chat);
    let changed = 0;
    let reasoning = 0;
    chat.forEach((msg, i) => {
        const r = cleanMessage(msg, depths[i], plan);
        if (r.changed) changed++;
        reasoning += r.reasoning;
    });
    return { changed, reasoning };
}

// ---------------------------------------------------------------- per-preset rules

function readPresetRules(name) {
    try {
        const v = presetManager()?.readPresetExtensionField?.({ name, path: FIELD });
        return v && typeof v === 'object' ? v : null;
    } catch {
        return null;
    }
}

async function writePresetRules(name, rules) {
    const pm = presetManager();
    if (!pm?.writePresetExtensionField || !name) return;
    const prev = readPresetRules(name);
    if (prev && prev.removeTags === rules.removeTags && prev.unwrapTags === rules.unwrapTags) return;
    try {
        await pm.writePresetExtensionField({ name, path: FIELD, value: rules });
    } catch (e) {
        console.warn(LOG, 'Could not save rules into the preset', e);
    }
}

// ---------------------------------------------------------------- dialog

function isGenerating() {
    const stop = $id('mes_stop');
    return !!stop && getComputedStyle(stop).display !== 'none';
}

function dialogHtml({ opts, scripts, lastId, presets, current }) {
    const checkbox = (name, label, hint = '') => `
        <label class="checkbox_label au-row">
            <input type="checkbox" name="${name}" ${opts[name] ? 'checked' : ''}>
            <span>${label}${hint ? ` <small class="au-hint">${hint}</small>` : ''}</span>
        </label>`;

    const groups = new Map();
    for (const s of scripts) {
        if (!groups.has(s.group)) groups.set(s.group, []);
        groups.get(s.group).push(s);
    }
    const scriptList = scripts.length
        ? [...groups].map(([group, list]) => `
            <div class="au-group">${esc(group)}</div>
            ${list.map(s => `
                <label class="checkbox_label au-row">
                    <input type="checkbox" data-script="${esc(s.key)}" ${opts.uncheckedScripts.includes(s.key) ? '' : 'checked'}>
                    <span>${esc(s.script.scriptName || '(ไม่มีชื่อ)')}</span>
                </label>`).join('')}`).join('')
        : `<div class="au-empty">${engine ? 'ไม่มี regex แบบ "Alter Outgoing Prompt" ที่เปิดอยู่' : 'โหลด Regex extension ไม่ได้ ข้ามขั้นนี้'}</div>`;

    const presetOptions = presets
        .map(p => `<option value="${esc(p)}">${esc(p)}${p === current ? ' (ที่ใช้อยู่)' : ''}</option>`)
        .join('');

    return `
    <div class="au-dialog">
        <h3 class="au-title"><i class="fa-solid fa-code-branch"></i> Alternate Universe</h3>
        <p class="au-lead">แตก branch ใหม่จากแชทนี้แล้วล้างแท็กและ CoT ของ preset <b>${esc(current || '-')}</b> ออก แชทเดิมไม่ถูกแตะ</p>

        <div class="au-grid">
        <section>
            <h4>1. Regex ที่ใช้ตอนส่ง prompt</h4>
            <p class="au-hint">ข้อความใน branch จะถูกเขียนทับด้วยผลของ regex พวกนี้ เท่ากับสิ่งที่ preset ปัจจุบันส่งให้ model จริง ๆ</p>
            <div class="au-scripts">${scriptList}</div>
            ${checkbox('ignoreDepth', 'ใช้กับทุกข้อความ ไม่สนช่วง depth', 'regex ที่ตั้ง Min/Max Depth ไว้จะถูกใช้กับทุกข้อความด้วย')}
        </section>

        <section>
            <h4>2. CoT / reasoning</h4>
            ${checkbox('stripReasoning', 'ลบ reasoning ทั้งหมด', 'ทั้งที่ parse แยกไว้แล้ว และ &lt;think&gt; ที่ค้างอยู่ในข้อความ')}

            <h4>3. แท็กเพิ่มเติม</h4>
            <label class="au-field">
                <span>ลบทั้งก้อน <small class="au-hint">ชื่อแท็ก คั่นด้วยจุลภาคหรือขึ้นบรรทัดใหม่ เช่น status, summary</small></span>
                <textarea class="text_pole" name="removeTags" rows="2">${esc(opts.removeTags)}</textarea>
            </label>
            <div class="au-leftover">
                <span class="au-hint">แท็กที่ยังเหลือหลังล้าง (แตะเพื่อเพิ่มในช่องลบทั้งก้อน)</span>
                <div class="au-chips"></div>
            </div>
            <label class="au-field">
                <span>ลบแค่แท็ก เก็บข้อความข้างใน</span>
                <textarea class="text_pole" name="unwrapTags" rows="2">${esc(opts.unwrapTags)}</textarea>
            </label>
            ${checkbox('stripComments', 'ลบ HTML comment &lt;!-- --&gt;')}
            ${checkbox('collapseBlank', 'เก็บบรรทัดว่างที่เหลือ')}
            ${checkbox('rememberPerPreset', 'จำรายชื่อแท็กไว้กับ preset นี้', 'บันทึกลงไฟล์ preset ติดไปตอน export')}
        </section>

        <section>
            <h4>4. ขอบเขต</h4>
            <label class="au-field au-inline">
                <span>แตกจากข้อความที่</span>
                <input class="text_pole" type="number" name="fromId" min="0" max="${lastId}" value="${lastId}">
                <small class="au-hint">(ล่าสุด = ${lastId})</small>
            </label>
            ${checkbox('includeUser', 'ล้างข้อความของผู้ใช้ด้วย')}
            <label class="au-field au-inline">
                <span>Swipe</span>
                <select class="text_pole" name="swipes">
                    <option value="all" ${opts.swipes === 'all' ? 'selected' : ''}>ล้างทุก swipe</option>
                    <option value="current" ${opts.swipes === 'current' ? 'selected' : ''}>เก็บแค่ swipe ที่เลือกอยู่</option>
                </select>
            </label>

            <h4>5. หลังล้างเสร็จ</h4>
            <label class="au-field au-inline">
                <span>เปลี่ยนไปใช้ preset</span>
                <select class="text_pole" name="targetPreset">
                    <option value="">ไม่เปลี่ยน</option>
                    ${presetOptions}
                </select>
            </label>
            ${hasPresetLock() ? checkbox('lockBranch', 'ล็อก preset ใหม่ไว้กับ branch นี้', 'ใช้ล็อกของ Preset Formatting เปิด branch นี้เมื่อไหร่จะได้ preset ใหม่ ส่วนล็อกเดิมที่ติดมาจากแชทแม่จะถูกเปลี่ยนตามเสมอ') : ''}
        </section>
        </div>

        <section class="au-preview-box">
            <h4>ตัวอย่าง <small class="au-hint au-stats"></small></h4>
            <pre class="au-preview"></pre>
        </section>
    </div>`;
}

function readDialog(root) {
    const q = name => root.querySelector(`[name="${name}"]`);
    const unchecked = [...root.querySelectorAll('input[data-script]')].filter(x => !x.checked).map(x => x.dataset.script);
    return {
        ignoreDepth: q('ignoreDepth').checked,
        stripReasoning: q('stripReasoning').checked,
        removeTags: q('removeTags').value,
        unwrapTags: q('unwrapTags').value,
        stripComments: q('stripComments').checked,
        collapseBlank: q('collapseBlank').checked,
        rememberPerPreset: q('rememberPerPreset').checked,
        includeUser: q('includeUser').checked,
        swipes: q('swipes').value,
        fromId: Number(q('fromId').value),
        targetPreset: q('targetPreset').value,
        lockBranch: q('lockBranch')?.checked ?? settings().lockBranch, // not shown without Preset Formatting 1.4+
        uncheckedScripts: unchecked,
    };
}

function selectedScripts(scripts, uncheckedKeys) {
    const off = new Set(uncheckedKeys);
    return scripts.filter(s => !off.has(s.key)).map(s => s.script);
}

function renderPreview(root, scripts) {
    const chat = ctx().chat ?? [];
    const opts = readDialog(root);
    const lastId = chat.length - 1;
    const fromId = Number.isInteger(opts.fromId) ? Math.min(Math.max(opts.fromId, 0), lastId) : lastId;
    const stats = root.querySelector('.au-stats');
    const pre = root.querySelector('.au-preview');

    let plan;
    try {
        plan = buildPlan(opts, selectedScripts(scripts, opts.uncheckedScripts));
    } catch (e) {
        stats.textContent = '';
        pre.textContent = `ตั้งค่าไม่ถูกต้อง: ${e.message}`;
        return;
    }

    const snapshot = structuredClone(chat.slice(0, fromId + 1));
    const r = cleanChat(snapshot, plan);
    stats.textContent = `· เปลี่ยน ${r.changed} จาก ${snapshot.length} ข้อความ${plan.stripReasoning ? ` · ลบ reasoning ${r.reasoning}` : ''}`;

    let idx = snapshot.length - 1;
    while (idx > 0 && (snapshot[idx]?.is_user || snapshot[idx]?.is_system)) idx--;
    const sample = snapshot[idx];
    pre.textContent = sample ? `#${idx} ${sample.name ?? ''}\n\n${sample.mes || '(ว่าง)'}` : '(ไม่มีข้อความ)';

    const tags = leftoverTags(snapshot);
    root.querySelector('.au-chips').innerHTML = tags.length
        ? tags.map(([name, n]) => `<button type="button" class="menu_button au-chip" data-tag="${esc(name)}">${esc(name)} <small>×${n}</small></button>`).join('')
        : '<span class="au-empty">ไม่เหลือแล้ว</span>';
}

function addRemoveTag(root, name) {
    const box = root.querySelector('[name="removeTags"]');
    if (parseTagList(box.value).includes(name)) return;
    box.value = box.value.trim() ? `${box.value.trim()}, ${name}` : name;
    box.dispatchEvent(new Event('input', { bubbles: true }));
}

async function openDialog() {
    const c = ctx();
    if (c.characterId === undefined && !c.groupId) return toast.info('เลือกตัวละครหรือกลุ่มก่อน');
    if (!c.chat?.length) return toast.warn('แชทนี้ยังไม่มีข้อความ');
    if (isGenerating()) return toast.warn('รอให้ model ตอบเสร็จก่อน');

    const s = settings();
    const current = currentPresetName();
    const rules = readPresetRules(current);
    const opts = {
        ...s,
        removeTags: rules?.removeTags ?? s.removeTags,
        unwrapTags: rules?.unwrapTags ?? s.unwrapTags,
    };
    const scripts = activePromptScripts();
    const lastId = c.chat.length - 1;
    const presets = presetManager()?.getAllPresets?.() ?? [];

    const wrap = document.createElement('div');
    wrap.innerHTML = dialogHtml({ opts, scripts, lastId, presets, current });
    const root = wrap.firstElementChild;
    const refresh = debounce(() => renderPreview(root, scripts), 200);
    root.addEventListener('input', refresh);
    root.addEventListener('change', refresh);
    root.addEventListener('click', e => {
        const chip = e.target.closest?.('.au-chip');
        if (chip) addRemoveTag(root, chip.dataset.tag);
    });
    renderPreview(root, scripts);

    const { callGenericPopup, POPUP_TYPE, POPUP_RESULT } = c;
    const result = await callGenericPopup(root, POPUP_TYPE.CONFIRM, '', {
        okButton: 'แตก branch และล้าง',
        cancelButton: 'ยกเลิก',
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });
    if (result !== POPUP_RESULT.AFFIRMATIVE) return;

    const chosen = readDialog(root);
    for (const k of Object.keys(DEFAULTS)) s[k] = chosen[k];
    save();
    if (chosen.rememberPerPreset && current) {
        await writePresetRules(current, { removeTags: chosen.removeTags, unwrapTags: chosen.unwrapTags });
    }

    await branchAndClean(chosen, selectedScripts(scripts, chosen.uncheckedScripts), current);
}

// ---------------------------------------------------------------- branch & clean

async function branchAndClean(opts, scripts, sourcePreset) {
    const c = ctx();
    const lastId = c.chat.length - 1;
    const fromId = Number.isInteger(opts.fromId) && opts.fromId >= 0 && opts.fromId <= lastId ? opts.fromId : lastId;

    let plan;
    try {
        plan = buildPlan(opts, scripts);
        // Dry run on a copy first so a broken rule never leaves a half-cleaned branch behind
        cleanChat(structuredClone(c.chat.slice(0, fromId + 1)), plan);
    } catch (e) {
        console.error(LOG, e);
        return toast.error(`ล้างไม่ได้: ${e.message}`);
    }

    const before = c.getCurrentChatId();
    let branchName = '';
    try {
        const r = await c.executeSlashCommandsWithOptions(`/branch-create ${fromId}`, { handleParserErrors: true, handleExecutionErrors: true });
        branchName = String(r?.pipe ?? '');
    } catch (e) {
        console.error(LOG, e);
    }

    const after = ctx();
    if (!branchName || after.getCurrentChatId() === before) {
        return toast.error('แตก branch ไม่สำเร็จ แชทเดิมไม่ถูกแก้');
    }

    const r = cleanChat(after.chat, plan);
    after.chatMetadata[FIELD] = {
        version: VERSION,
        at: Date.now(),
        fromChat: before,
        fromMessage: fromId,
        fromPreset: sourcePreset || null,
    };

    const pm = presetManager();
    let target = opts.targetPreset && opts.targetPreset !== currentPresetName() ? opts.targetPreset : '';
    const targetValue = target ? pm?.findPreset?.(target) : null;
    if (target && (targetValue === undefined || targetValue === null)) {
        toast.warn(`ไม่พบ preset "${target}"`);
        target = '';
    }
    if (target) relockBranch(after.chatMetadata, target, !!opts.lockBranch && hasPresetLock());
    await after.saveChat();

    let switched = '';
    if (target) {
        // Switching preset may apply a Regex Preset (Preset Formatting / connection profile), which
        // reloads the chat anyway; only reload ourselves when it did not, so the branch loads once.
        const reloaded = waitForEvent(ctx().event_types.CHAT_CHANGED, 1500);
        await pm.selectPreset(targetValue);
        switched = ` แล้วเปลี่ยนเป็น ${target}`;
        if (!(await reloaded)) await ctx().reloadCurrentChat();
    } else {
        await after.reloadCurrentChat();
    }

    toast.ok(`สร้าง "${branchName}" ล้างไป ${r.changed} ข้อความ${plan.stripReasoning && r.reasoning ? ` ลบ reasoning ${r.reasoning}` : ''}${switched}`);
}

// ---------------------------------------------------------------- menu & commands

function addMenuItem() {
    if ($id(MENU_ID)) return;
    const content = document.querySelector('#options .options-content');
    if (!content) return;

    const a = document.createElement('a');
    a.id = MENU_ID;
    a.title = 'แตก branch แล้วล้างแท็ก/CoT ของ preset ก่อนเปลี่ยน preset';
    a.innerHTML = '<i class="fa-lg fa-solid fa-code-branch"></i><span>Alternate Universe</span>';
    a.addEventListener('click', () => {
        $('#options').hide();
        openDialog().catch(e => {
            console.error(LOG, e);
            toast.error(e.message);
        });
    });

    const anchor = $id('option_new_bookmark');
    if (anchor) anchor.after(a); else content.prepend(a);
    syncMenuItem();
}

function syncMenuItem() {
    const a = $id(MENU_ID);
    if (!a) return;
    const c = ctx();
    const hasChat = (c.characterId !== undefined || !!c.groupId) && !!c.chatId;
    a.style.display = hasChat ? '' : 'none';
}

function registerCommands() {
    const { SlashCommandParser, SlashCommand } = ctx();
    if (!SlashCommandParser?.addCommandObject || !SlashCommand?.fromProps) return;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'alternate-universe',
        aliases: ['au'],
        callback: async () => {
            await openDialog();
            return '';
        },
        helpString: 'เปิดหน้าต่าง Alternate Universe: แตก branch ใหม่แล้วล้างแท็กและ CoT ของ preset ปัจจุบัน',
    }));
}

// ---------------------------------------------------------------- init

(async function init() {
    settings();
    await loadEngine();
    addMenuItem();
    registerCommands();

    const { eventSource, event_types: E } = ctx();
    eventSource.on(E.CHAT_CHANGED, () => { addMenuItem(); syncMenuItem(); });
    eventSource.once(E.APP_READY, () => { addMenuItem(); syncMenuItem(); });
    console.log(LOG, `v${VERSION} loaded`);
})();
