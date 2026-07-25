const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const JS_DIR = path.join(ROOT, 'public', 'js');
const CSS_DIR = path.join(ROOT, 'public', 'css');

const EXPECTED_SCRIPTS = [
    '00-state.js',
    '05-utils.js',
    '10-auth.js',
    '20-socket.js',
    '30-room.js',
    '40-profile.js',
    '41-history.js',
    '42-replay.js',
    '50-audio-settings.js',
    '60-chat.js',
    '61-voice.js',
    '70-actions.js',
    '80-table-renderer.js',
    '90-admin.js',
    '99-bootstrap.js'
];

const EXPECTED_STYLES = [
    '00-shell.css',
    '10-auth-user.css',
    '20-table.css',
    '30-lobby.css',
    '40-settings.css',
    '41-table-menu.css',
    '42-chat-voice.css',
    '43-modals.css',
    '44-replay.css',
    '45-profile.css',
    '46-history.css',
    '50-effects.css'
];

function loadedAssets(pattern) {
    return [...INDEX.matchAll(pattern)].map(match => match[1]);
}

function source(file) {
    return fs.readFileSync(path.join(JS_DIR, file), 'utf8');
}

function declarationCount(symbol) {
    const pattern = new RegExp(`(?:function|const|let|var)\\s+${symbol}\\b`, 'g');
    return EXPECTED_SCRIPTS.reduce((total, file) => total + (source(file).match(pattern) || []).length, 0);
}

test('index loads componentized scripts and styles in dependency order', () => {
    assert.deepEqual(loadedAssets(/<script src="\/js\/([^"]+)"><\/script>/g), EXPECTED_SCRIPTS);
    assert.deepEqual(loadedAssets(/<link rel="stylesheet" href="\/css\/([^"]+)">/g), EXPECTED_STYLES);
    for (const file of EXPECTED_SCRIPTS) assert.equal(fs.existsSync(path.join(JS_DIR, file)), true, file);
    for (const file of EXPECTED_STYLES) assert.equal(fs.existsSync(path.join(CSS_DIR, file)), true, file);
});

test('index contains no large inline style or application script', () => {
    assert.doesNotMatch(INDEX, /<style(?:\s|>)/);
    assert.doesNotMatch(INDEX, /<script>\s*\/\/ ===== State =====/);
});

test('state module owns data only and does not manipulate the DOM', () => {
    const state = source('00-state.js');
    assert.doesNotMatch(state, /\bdocument\b/);
    assert.doesNotMatch(state, /\bquerySelector\b|\bgetElementById\b|\bclassList\b/);
});

test('shared utilities and reassigned controls have one owner', () => {
    for (const symbol of [
        'escapeHtml',
        'hashHue',
        'AVATARS',
        'renderRoomList',
        'toggleFullscreen',
        'toggleReady',
        'startGame',
        'addTime',
        'rabbitDeal'
    ]) {
        assert.equal(declarationCount(symbol), 1, `${symbol} must have exactly one declaration`);
    }

    assert.match(source('05-utils.js'), /function escapeHtml\b/);
    assert.match(source('30-room.js'), /function renderRoomList\b/);
    assert.match(source('50-audio-settings.js'), /function toggleFullscreen\b/);
    assert.match(source('70-actions.js'), /function toggleReady\b/);
});
