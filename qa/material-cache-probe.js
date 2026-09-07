(async () => {
    const renderer = _reflectionPipeline.pipeline.renderer;
    const objects = renderer._objects;
    const original = objects.get;
    const records = new Map();
    objects.get = function (...args) {
        const old = this.getChainMap(args[7]).get([args[0],args[1],args[5],args[4]]);
        if(records.size<24 && old && (old.needsUpdate || old.version !== old.material.version)) {
            const name=old.object.name||old.object.type;
            const key=name+':'+old.material.type;
            const record=records.get(key)??{name,material:old.material.type,count:0};
            record.count++;record.materialVersion=old.material.version;record.objectVersion=old.version;
            record.initialNodesKey=old.initialNodesCacheKey;record.dynamicKey=old.getDynamicCacheKey();
            record.clipping=old.clippingNeedsUpdate;record.initialClip=old.clippingContextCacheKey;
            record.shadow=old.material.isShadowPassMaterial;record.context=renderer.contextNode.id;
            records.set(key,record);
        }
        const result = original.apply(this, args);
        if(records.size<16 && (result.needsUpdate || result.version !== result.material.version)) {
            const name=result.object.name||result.object.type;
            const key=name+':'+result.material.type;
            const record=records.get(key)??{name,material:result.material.type,count:0};
            record.count++; record.materialVersion=result.material.version;record.objectVersion=result.version;
            record.initialNodesKey=result.initialNodesCacheKey;record.dynamicKey=result.getDynamicCacheKey();
            record.clipping=result.clippingNeedsUpdate;record.initialClip=result.clippingContextCacheKey;
            record.shadow=result.material.isShadowPassMaterial; record.context=renderer.contextNode.id;
            records.set(key,record);
        }
        return result;
    };
    try { await new Promise(r=>setTimeout(r,1200)); return {records:[...records.values()]}; }
    finally { objects.get=original; }
})()
