const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = __dirname;

test('server entry stays an assembly module', () => {
    const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.ok(source.split('\n').length < 150);
    assert.match(source, /createTableService/);
    assert.match(source, /registerSocketHandlers/);
    assert.doesNotMatch(source, /socket\.on\(/);
    assert.doesNotMatch(source, /app\.post\('\/api\/voice/);
});

test('server module boundaries exist', () => {
    [
        'src/config.js',
        'src/runtime.js',
        'src/auth.js',
        'src/http/register-admin-routes.js',
        'src/http/register-auth-routes.js',
        'src/http/register-account-routes.js',
        'src/voice/voice-module.js',
        'src/table/table-service.js',
        'src/socket/register-socket-handlers.js'
    ].forEach(relative => assert.ok(fs.existsSync(path.join(root, relative)), relative));
});
