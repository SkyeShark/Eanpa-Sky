// World-aligned rainfall history. Thin wetness and pooled water integrate the
// same local cloud supply as drops/audio, then dry independently of that supply.
// No terrain identification or per-receiver CPU updates are required.
export function makeRainAccumulationField(T, {cellAt, rain, wetTarget,
    radius=1024, resolution=256, refreshSeconds=.25}={}) {
    const size=Math.max(64,Math.round(resolution)),span=radius*2,texel=span/size;
    const targets=[0,1].map(()=>new T.RenderTarget(size,size,{
        type:T.HalfFloatType,depthBuffer:false,generateMipmaps:false,
        minFilter:T.NearestFilter,magFilter:T.NearestFilter,
    }));
    for(const target of targets)target.texture.name='rainfall-wetness-water-history';
    const shared=value=>T.uniform(value).setGroup(T.renderGroup);
    const center=shared(new T.Vector2()),previousCenter=shared(new T.Vector2());
    const ready=shared(0),elapsedBlend=shared(new T.Vector4());
    const history=T.texture(targets[0].texture),published=T.texture(targets[0].texture);
    history.updateMatrix=published.updateMatrix=false;
    const advance=(state,blend)=>T.vec2(
        T.mix(state.r,state.b,T.select(state.b.greaterThan(state.r),blend.x,blend.y)),
        T.mix(state.g,state.a,T.select(state.a.greaterThan(state.g),blend.z,blend.w)),
    );
    const uvAt=(world,origin)=>world.xz.sub(origin).div(span).add(.5);
    const inside=uv=>uv.x.greaterThanEqual(0).and(uv.y.greaterThanEqual(0))
        .and(uv.x.lessThan(1)).and(uv.y.lessThan(1));
    // Sampler-free bilinear reconstruction adds one texture binding and no
    // sampler to native PBR materials already using many mapped surfaces.
    const filtered=(map,uv)=>{
        const p=uv.mul(size).sub(.5),i=T.floor(p),f=T.fract(p);
        const load=offset=>T.textureLoad(map,T.ivec2(i.add(offset).clamp(0,size-1))).level(0);
        return T.mix(T.mix(load(T.vec2(0,0)),load(T.vec2(1,0)),f.x),
            T.mix(load(T.vec2(0,1)),load(T.vec2(1,1)),f.x),f.y);
    };
    const material=new T.MeshBasicNodeMaterial({toneMapped:false,fog:false});
    material.name='Integrate local rainfall into surface water';
    material.fragmentNode=T.Fn(()=>{
        const xz=T.screenUV.sub(.5).mul(span).add(center);
        const world=T.vec3(xz.x,0,xz.y),oldUV=uvAt(world,previousCenter);
        const moisture=T.vec2(0).toVar();
        T.If(ready.greaterThan(0).and(inside(oldUV)),()=>{
            // Recentering uses an integer texel offset, so history is copied
            // without repeated filtering or drift during ordinary walking.
            const state=T.textureLoad(history,T.ivec2(T.floor(oldUV.mul(size)))).level(0);
            moisture.assign(advance(state,elapsedBlend));
        });
        // A sustained modest shower can fill a puddle. Local rain controls
        // when filling begins; it need not reach the maximum storm density.
        const localSupply=T.smoothstep(0,.10,cellAt(world).mul(rain));
        const damp=T.select(rain.lessThanEqual(.001),wetTarget,0);
        const desiredWet=T.max(wetTarget.mul(localSupply),damp).clamp();
        const desiredWater=T.pow(wetTarget.max(0),1.8).mul(localSupply).clamp();
        return T.vec4(moisture,desiredWet,desiredWater);
    })();
    const quad=new T.QuadMesh(material),context=T.context({});
    const cameraWorld=new T.Vector3(),nextCenter=new T.Vector2();
    const stats={captures:0,resolution:size,radiusMeters:radius,refreshSeconds,
        historyBytes:size*size*8*2,ready:false,lastUpdateSeconds:null};
    let current=0,lastTime=-Infinity,disposed=false;
    const setElapsed=time=>{
        const dt=Number.isFinite(lastTime)?Math.max(0,time-lastTime):0;
        elapsedBlend.value.set(-Math.expm1(-dt/7),-Math.expm1(-dt/70),
            -Math.expm1(-dt/32),-Math.expm1(-dt/150));
    };
    return {stats,
        sample(world){return T.Fn(()=>{
            const value=T.vec2(0).toVar(),uv=uvAt(world,center);
            T.If(ready.greaterThan(0).and(inside(uv)),()=>{
                // Advance from the last published state every displayed frame;
                // the 4 Hz history update never makes wetness step at 4 Hz.
                const state=filtered(published,uv).toVar();
                const edge=T.max(T.abs(uv.x.sub(.5)),T.abs(uv.y.sub(.5)));
                value.assign(advance(state,elapsedBlend).mul(T.smoothstep(.4,.5,edge).oneMinus()));
            });return value;
        })();},
        async prepare(renderer,camera,time,{force=false,active=true}={}){
            if(disposed||!camera)return false;
            setElapsed(time);
            if(!force&&!active)return false;
            const rewound=time<lastTime;
            camera.getWorldPosition(cameraWorld);
            nextCenter.set(Math.floor(cameraWorld.x/texel)*texel,Math.floor(cameraWorld.z/texel)*texel);
            const moved=Math.max(Math.abs(cameraWorld.x-center.value.x),Math.abs(cameraWorld.z-center.value.y))>radius*.25;
            if(!force&&ready.value&&!rewound&&!moved&&time-lastTime<refreshSeconds)return false;
            const saved=T.RendererUtils.saveRendererState(renderer),oldContext=renderer.contextNode;
            const oldCenter=center.value.clone(),oldPrevious=previousCenter.value.clone(),oldReady=ready.value;
            const next=1-current;
            try{
                previousCenter.value.copy(center.value);
                if(!ready.value||moved||rewound)center.value.copy(nextCenter);
                if(rewound)ready.value=0;
                renderer.contextNode=context;renderer.setMRT(null);renderer.setRenderTarget(targets[next]);
                await quad.renderAsync(renderer);
                current=next;published.value=history.value=targets[current].texture;
                lastTime=time;elapsedBlend.value.set(0,0,0,0);ready.value=1;
                stats.ready=true;stats.captures++;stats.lastUpdateSeconds=time;
                return true;
            }catch(error){center.value.copy(oldCenter);previousCenter.value.copy(oldPrevious);ready.value=oldReady;throw error;}
            finally{renderer.contextNode=oldContext;T.RendererUtils.restoreRendererState(renderer,saved);}
        },
        reset(){lastTime=-Infinity;ready.value=0;elapsedBlend.value.set(0,0,0,0);stats.ready=false;stats.lastUpdateSeconds=null;},
        dispose(){if(disposed)return;disposed=true;ready.value=0;stats.ready=false;for(const target of targets)target.dispose();material.dispose();},
    };
}
