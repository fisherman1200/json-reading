const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const names = ['cascade-notes.png', 'field-hints.png', 'field-hover.png', 'relation-results.png', 'table-sidebar.png'];
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function checkPublicScreenshots(readme) {
    const urls = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(match => match[1]);
    assert.equal(urls.length, names.length, 'Expected exactly five demo screenshots');
    const seen = new Set();
    for (const url of urls) {
        const parsed = new URL(url);
        assert.equal(parsed.origin, 'https://raw.githubusercontent.com');
        assert(!parsed.search && !parsed.hash && !parsed.username && !parsed.password);
        assert.match(parsed.pathname, /^\/fisherman1200\/json-reading-screenshots\/[a-f0-9]{40}\/[^/]+\.png$/,
            'Screenshot URL must pin a commit in the dedicated public repository');
        const name = path.posix.basename(parsed.pathname);
        assert(names.includes(name) && !seen.has(name), 'Unexpected or duplicate screenshot: ' + name);
        seen.add(name);
    }
    const results = await Promise.allSettled(urls.map(async url => {
        const name = path.posix.basename(new URL(url).pathname);
        // Deliberately omit authentication: Marketplace visitors must be able to load these images.
        const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
        assert.equal(response.status, 200, name + ': anonymous HTTPS request failed');
        assert.match(response.headers.get('content-type') || '', /^image\/png(?:;|$)/i);
        const remote = Buffer.from(await response.arrayBuffer());
        assert.equal(remote.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', name + ': invalid PNG');
        const local = await fs.readFile(path.join(root, 'media/screenshots', name));
        assert.equal(sha256(remote), sha256(local), name + ': remote image differs from local reviewed image');
        return { name, url, status: response.status, bytes: remote.length, sha256: sha256(remote), matchesLocal: true };
    }));
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Public screenshot verification failed');
    return results.map(result => result.value);
}

module.exports = { checkPublicScreenshots };
if (require.main === module) {
    fs.readFile(path.join(root, 'README.md'), 'utf8')
        .then(checkPublicScreenshots)
        .then(results => console.log(JSON.stringify(results, null, 2)))
        .catch(error => { console.error(error); process.exitCode = 1; });
}
