// A sun-column transmittance field shared by every receiving material.
// Project receivers along the light direction onto the capture plane: roofs,
// slopes and the ground then sample the same cloud column without a ray march
// in each PBR fragment. The host calls prepare() in its serialized frame.
export function makeCloudShadowMap(T, {transmittance, lightDirection, time,
    resolution=384, extent=6144, refreshSeconds=.1}={}) {
    const size=Math.max(64,Math.round(resolution));
    const target=new T.RenderTarget(size,size,{type:T.HalfFloatType,depthBuffer:false,
        minFilter:T.LinearFilter,magFilter:T.LinearFilter,generateMipmaps:false});
    target.texture.name='cloud-column-transmittance';
    const shared=value=>T.uniform(value).setGroup(T.renderGroup);
    const origin=shared(new T.Vector2()),captureLight=shared(new T.Vector3(0,1,0)),ready=shared(0);
    const material=new T.MeshBasicNodeMaterial();
    material.name='Cloud shadow column integration';
    const p=T.vec3(T.uv().x.sub(.5).mul(extent).add(origin.x),0,
        T.uv().y.sub(.5).mul(extent).add(origin.y));
    material.fragmentNode=T.vec4(T.vec3(transmittance(p)),1);
    const quad=new T.QuadMesh(material);
    const captureContext=T.context({});
    const map=T.texture(target.texture,T.screenUV);
    const stats={resolution:size,extent,refreshSeconds,captures:0};
    let lastTime=-Infinity,disposed=false;
    const texel=extent/size;
    return {target,stats,
        sample(world){
            const hit=world.xz.sub(captureLight.xz.mul(world.y.div(T.max(captureLight.y,.02))));
            const uv=hit.sub(origin).div(extent).add(.5);
            const edge=T.max(T.abs(uv.x.sub(.5)),T.abs(uv.y.sub(.5)));
            const weight=T.smoothstep(.46,.5,edge).oneMinus().mul(ready);
            // QuadMesh already uses top-left UVs, matching WebGPU textures.
            return T.mix(1,map.sample(uv).level(0).r,weight);
        },
        async prepare(renderer,camera,force=false){
            if(disposed||!camera)return false;
            const light=lightDirection.value,t=time.value;
            const x=Math.floor((camera.position.x-light.x*camera.position.y/Math.max(light.y,.02))/texel)*texel;
            const z=Math.floor((camera.position.z-light.z*camera.position.y/Math.max(light.y,.02))/texel)*texel;
            const moved=Math.abs(origin.value.x-x)>extent*.125||Math.abs(origin.value.y-z)>extent*.125;
            const turned=captureLight.value.dot(light)<.9995;
            if(!force&&ready.value&&!moved&&!turned&&t>=lastTime&&t-lastTime<refreshSeconds)return false;
            const saved={target:renderer.getRenderTarget(),mrt:renderer.getMRT(),context:renderer.contextNode};
            try{
                origin.value.set(x,z);captureLight.value.copy(light);
                renderer.setMRT(null);renderer.contextNode=captureContext;renderer.setRenderTarget(target);
                await quad.renderAsync(renderer);
                ready.value=1;lastTime=t;stats.captures++;
                return true;
            }finally{renderer.contextNode=saved.context;renderer.setRenderTarget(saved.target);renderer.setMRT(saved.mrt);}
        },
        dispose(){if(disposed)return;disposed=true;target.dispose();material.dispose();},
    };
}
