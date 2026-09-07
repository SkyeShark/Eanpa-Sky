import { connect } from './cdp.mjs';
import { writeFile } from 'node:fs/promises';
const cdp=await connect();
try {
    await cdp.evaluate(`(() => {
        const info=_reflectionPipeline.pipeline.renderer.info;
        const records=new Map(), create=info.createAttribute, destroy=info.destroyAttribute;
        globalThis.__qaAttributes={info,records,create,destroy};
        info.createAttribute=function(a){
            create.call(this,a);records.set(a,{name:a.name,type:a.constructor.name,
                count:a.count,itemSize:a.itemSize,bytes:a.array?.byteLength??a.data?.array?.byteLength,
                stack:new Error().stack,deleted:false});
        };
        info.destroyAttribute=function(a){
            destroy.call(this,a);if(records.has(a))records.get(a).deleted=true;
        };
    })()`);
    for (const quality of ['high','balanced']) {
        await cdp.evaluate(`(() => {const e=document.getElementById('quality');e.value='${quality}';e.dispatchEvent(new Event('change'));})()`);
        while(!await cdp.evaluate("document.getElementById('boot').style.display==='none'")) await new Promise(r=>setTimeout(r,500));
        await new Promise(r=>setTimeout(r,2500));
    }
    const result=await cdp.evaluate(`(() => {
        const {records}=__qaAttributes;
        _c.parent.traverse(o=>{
            const attrs={...o.geometry?.attributes,instanceMatrix:o.instanceMatrix,instanceColor:o.instanceColor};
            for(const [key,a] of Object.entries(attrs)){
                if(records.has(a))records.get(a).owner=(o.name||o.type)+'.'+key;
                if(a?.data&&records.has(a.data))records.get(a.data).owner=(o.name||o.type)+'.'+key+'.data';
            }
        });
        return {memory:_reflectionPipeline.pipeline.renderer.info.memory,records:[...records.values()]};
    })()`);
    await writeFile('artifacts/overhaul/attribute-lifetime.json',JSON.stringify(result,null,2));
    console.log(JSON.stringify(result.records.filter(r=>!r.deleted).map(({stack,...r})=>r),null,2));
} finally {
    await cdp.evaluate(`if(globalThis.__qaAttributes){const q=__qaAttributes;
        q.info.createAttribute=q.create;q.info.destroyAttribute=q.destroy;delete globalThis.__qaAttributes;}`).catch(()=>{});
    cdp.close();
}
