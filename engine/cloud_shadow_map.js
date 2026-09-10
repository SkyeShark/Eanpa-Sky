// A sun-column transmittance field shared by every receiving material.
// Project receivers along the light direction onto the capture plane: roofs,
// slopes and the ground then sample the same cloud column without a ray march
// in each PBR fragment. The host calls prepare() in its serialized frame.
export function makeCloudShadowMap(T, {transmittance, lightDirection, time, displacement,
    resolution=384, extent=6144, refreshSeconds=.1}={}) {
    const size=Math.max(64,Math.round(resolution));
    const target=new T.RenderTarget(size,size,{type:T.HalfFloatType,depthBuffer:false,
        minFilter:T.LinearFilter,magFilter:T.LinearFilter,generateMipmaps:false});
    target.texture.name='cloud-column-transmittance';
    const shared=value=>T.uniform(value).setGroup(T.renderGroup);
    const origin=shared(new T.Vector3()),captureLight=shared(new T.Vector3(0,1,0)),ready=shared(0);
    const right=shared(new T.Vector3(1,0,0)),up=shared(new T.Vector3(0,0,-1));
    const captureDisplacement=shared(new T.Vector3());
    const material=new T.MeshBasicNodeMaterial();
    material.name='Cloud shadow column integration';
    const p=origin.add(right.mul(T.uv().x.sub(.5).mul(extent)))
        .add(up.mul(T.uv().y.sub(.5).mul(extent)));
    material.fragmentNode=T.vec4(T.vec3(transmittance(p)),1);
    const quad=new T.QuadMesh(material);
    const captureContext=T.context({});
    const map=T.texture(target.texture,T.screenUV);
    const stats={resolution:size,extent,refreshSeconds,captures:0,projection:'orthographic-light-columns'};
    const cameraWorld=new T.Vector3(),nextOrigin=new T.Vector3(),nextRight=new T.Vector3(),nextUp=new T.Vector3();
    let lastTime=-Infinity,disposed=false;
    const texel=extent/size;
    return {target,stats,projection:{origin,right,up,light:captureLight},
        sample(world){
            const advection=displacement?displacement.sub(captureDisplacement):T.vec3(0);
            const relative=world.sub(origin).sub(advection);
            const uv=T.vec2(T.dot(relative,right),T.dot(relative,up)).div(extent).add(.5);
            const edge=T.max(T.abs(uv.x.sub(.5)),T.abs(uv.y.sub(.5)));
            const weight=T.smoothstep(.46,.5,edge).oneMinus().mul(ready);
            // QuadMesh already uses top-left UVs, matching WebGPU textures.
            return T.mix(1,map.sample(uv).level(0).r,weight);
        },
        async prepare(renderer,camera,force=false){
            if(disposed||!camera)return false;
            if(typeof force==='object')force=force?.force===true;
            const light=lightDirection.value,t=time.value;
            camera.getWorldPosition(cameraWorld);
            nextRight.set(light.z,0,-light.x);
            if(nextRight.lengthSq()<.000001)nextRight.set(1,0,0);else nextRight.normalize();
            nextUp.crossVectors(light,nextRight).normalize();
            const x=Math.floor(cameraWorld.dot(nextRight)/texel)*texel;
            const y=Math.floor(cameraWorld.dot(nextUp)/texel)*texel;
            // Keep the whole integration plane below the local cloud deck.
            // Its distance along the light does not change the sampled column.
            // Unlike projection onto Y=0, roofs remain in this footprint even
            // when a near-horizontal sun casts kilometre-long shadows.
            const along=cameraWorld.dot(light)-(cameraWorld.y+64+extent*.5*Math.abs(nextUp.y))/Math.max(light.y,.001);
            nextOrigin.copy(nextRight).multiplyScalar(x).addScaledVector(nextUp,y).addScaledVector(light,along);
            const relative=cameraWorld.clone().sub(origin.value);
            const moved=Math.abs(relative.dot(right.value))>extent*.125||Math.abs(relative.dot(up.value))>extent*.125;
            const turned=captureLight.value.dot(light)<.9995;
            if(!force&&ready.value&&!moved&&!turned&&t>=lastTime&&t-lastTime<refreshSeconds)return false;
            const saved={target:renderer.getRenderTarget(),mrt:renderer.getMRT(),context:renderer.contextNode};
            const oldOrigin=origin.value.clone(),oldLight=captureLight.value.clone(),oldDisplacement=captureDisplacement.value.clone();
            const oldRight=right.value.clone(),oldUp=up.value.clone();
            try{
                // Keep the sample lattice world-stable while the viewer walks.
                // Recenter only at the guard band, not on every 10 Hz refresh.
                if(!ready.value||moved||turned){origin.value.copy(nextOrigin);right.value.copy(nextRight);up.value.copy(nextUp);}
                captureLight.value.copy(light);
                if(displacement)captureDisplacement.value.copy(displacement.value);
                renderer.setMRT(null);renderer.contextNode=captureContext;renderer.setRenderTarget(target);
                await quad.renderAsync(renderer);
                ready.value=1;lastTime=t;stats.captures++;
                return true;
            }catch(error){
                // A failed refresh must retain the projection belonging to
                // the last successfully published texture.
                origin.value.copy(oldOrigin);captureLight.value.copy(oldLight);captureDisplacement.value.copy(oldDisplacement);
                right.value.copy(oldRight);up.value.copy(oldUp);
                throw error;
            }finally{renderer.contextNode=saved.context;renderer.setRenderTarget(saved.target);renderer.setMRT(saved.mrt);}
        },
        dispose(){if(disposed)return;disposed=true;target.dispose();material.dispose();},
    };
}
