import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const start = source.indexOf('const automatedPreview =');
const end = source.indexOf("document.addEventListener('mousemove'", start);
assert.ok(start >= 0 && end > start);
const compile = Function('canvas', 'document', 'location', 'look', source.slice(start, end));

function harness({ automated = false, hidden = false, focused = true } = {}) {
    let pointerdown, requests = 0;
    const canvas = {
        addEventListener(type, callback) { pointerdown = callback; },
        requestPointerLock() { requests++; return Promise.resolve(); },
    };
    const document = { hidden, hasFocus: () => focused, pointerLockElement: null };
    const look = { pointerLockRequests: 0, pointerLockErrors: 0 };
    compile(canvas, document, { search: automated ? '?automated=1' : '' }, look);
    return { canvas, document, look, click: (event = {}) => pointerdown({ button: 0, isTrusted: true, ...event }),
        get requests() { return requests; } };
}

test('automated preview cannot capture the mouse, including trusted input', () => {
    const h = harness({ automated: true });
    h.click(); h.click({ isTrusted: false });
    assert.equal(h.requests, 0);
    assert.equal(h.look.pointerLockRequests, 0);
});

test('hidden, unfocused, and synthetic pointer events cannot request mouse capture', () => {
    for (const options of [{ hidden: true }, { focused: false }, {}]) {
        const h = harness(options);
        h.click(Object.keys(options).length ? {} : { isTrusted: false });
        assert.equal(h.requests, 0);
    }
});

test('interactive preview captures once on a real primary click', () => {
    const h = harness();
    h.click({ button: 2 });
    assert.equal(h.requests, 0);
    h.click();
    assert.equal(h.requests, 1);
    assert.equal(h.look.pointerLockRequests, 1);
    h.document.pointerLockElement = h.canvas;
    h.click();
    assert.equal(h.requests, 1);
});
