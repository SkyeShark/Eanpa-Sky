// Batch explicitly immutable, repeated meshes without merging or simplifying
// their geometry. Small spatial cells retain useful frustum/shadow culling.
export function makeStaticInstances(T, parent, roots, {cellSize=64}={}) {
    parent.updateWorldMatrix(true,true);
    const inverse=parent.matrixWorld.clone().invert(),matrix=new T.Matrix4(),center=new T.Vector3();
    const groups=new Map(),batches=[],sources=[];
    for(const root of roots)root.traverseVisible(object=>{
        if(!object.isMesh||object.isInstancedMesh||object.isSkinnedMesh||object.morphTargetInfluences
            ||Array.isArray(object.material)||object.material.transparent)return;
        matrix.multiplyMatrices(inverse,object.matrixWorld);
        // Mirrored instances require a different front-face convention.
        if(matrix.determinant()<=0)return;
        center.setFromMatrixPosition(matrix);
        const key=[object.geometry.id,object.material.id,object.castShadow,object.receiveShadow,
            object.renderOrder,object.layers.mask,Math.floor(center.x/cellSize),Math.floor(center.z/cellSize)].join(':');
        const entries=groups.get(key)??[];entries.push({object,matrix:matrix.clone()});groups.set(key,entries);
    });
    for(const entries of groups.values()){
        if(entries.length<2)continue;
        const source=entries[0].object,batch=new T.InstancedMesh(source.geometry,source.material,entries.length);
        batch.name=`static_instances_${source.name}`;
        batch.castShadow=source.castShadow;batch.receiveShadow=source.receiveShadow;
        batch.renderOrder=source.renderOrder;batch.layers.mask=source.layers.mask;
        batch.userData={...source.userData,staticInstanceSources:entries.map(e=>e.object.name)};
        entries.forEach((entry,i)=>{batch.setMatrixAt(i,entry.matrix);sources.push(entry.object);entry.object.visible=false;});
        batch.instanceMatrix.needsUpdate=true;
        batch.computeBoundingBox();batch.computeBoundingSphere();parent.add(batch);batches.push(batch);
    }
    let enabled=true,disposed=false;
    const stats={sourceMeshes:sources.length,drawMeshes:batches.length,cellSize};
    return {stats,batches,
        setEnabled(value){if(disposed)return;enabled=!!value;for(const o of sources)o.visible=!enabled;for(const b of batches)b.visible=enabled;},
        get enabled(){return enabled},
        dispose(){if(disposed)return;disposed=true;for(const b of batches){b.removeFromParent();b.dispose()}
            for(const o of sources)o.visible=true;batches.length=0;sources.length=0;},
    };
}
