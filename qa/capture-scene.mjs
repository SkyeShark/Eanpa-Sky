import { connect } from './cdp.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
const cdp = await connect();
try {
    const [name = 'view', pitch = '0.035', yaw = '0'] = process.argv.slice(2);
    const deadline = Date.now()+180000;
    while (!await cdp.evaluate("document.getElementById('boot').style.display === 'none'")) {
        if (Date.now()>deadline) throw new Error('Scene failed to finish building');
        await new Promise(r=>setTimeout(r,1000));
    }
    await cdp.evaluate(`_eanpaTest.paused=false; _look.pitch=${Number(pitch)}; _look.yaw=${Number(yaw)}; _look.vpitch=0; _look.vyaw=0;`);
    await new Promise(r=>setTimeout(r,1500));
    const data = await cdp.send('Page.captureScreenshot', {format:'png',captureBeyondViewport:false});
    const path = `artifacts/overhaul/${name}.png`;
    await mkdir(dirname(path),{recursive:true});
    await writeFile(path,Buffer.from(data.data,'base64'));
    console.log(path);
} finally { cdp.close(); }
