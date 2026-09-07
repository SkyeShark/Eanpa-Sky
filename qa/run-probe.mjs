import { connect } from './cdp.mjs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
const [name] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Use a QA probe name');
const cdp = await connect();
try {
    const result = await cdp.evaluate(await readFile(`qa/${name}.js`, 'utf8'));
    await mkdir('artifacts/overhaul', { recursive: true });
    await writeFile(`artifacts/overhaul/${name}.json`, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    if (result?.pass === false) process.exitCode = 1;
} finally { cdp.close(); }
