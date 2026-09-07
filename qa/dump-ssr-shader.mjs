import { connect } from './cdp.mjs';
import { writeFile } from 'node:fs/promises';
const cdp = await connect();
try {
    const shaders = await cdp.evaluate(`(() => {
        const states=Array.from(_reflectionPipeline.pipeline.renderer._nodes.nodeBuilderCache.values());
        return states.map(s=>s.fragmentShader).filter(s=>s?.includes('continue;')&&s.includes('textureLoad')&&s.includes('1.5'));
    })()`);
    for (let i=0;i<shaders.length;i++) await writeFile('artifacts/overhaul/ssr-shader-'+i+'.wgsl',shaders[i]);
    console.log(shaders.map((s,i)=>({index:i,length:s.length})));
} finally { cdp.close(); }
