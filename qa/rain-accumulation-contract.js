(async()=>{
    // Numerical GPU contract: no dependence on the demo scene or cloud phase.
    const wasPaused=_eanpaTest.paused;
    if(!wasPaused){_eanpaTest.pauseAfterFrame=true;while(!_eanpaTest.paused)await new Promise(r=>setTimeout(r,10));}
    const T=THREE,renderer=_reflectionPipeline.pipeline.renderer;
    const {makeRainAccumulationField}=await import('/engine/rain_accumulation_field.js');
    const rain=T.uniform(.7),supply=T.uniform(0),target=T.uniform(.85);
    const field=makeRainAccumulationField(T,{cellAt:p=>T.select(p.x.lessThan(0),supply,0),
        rain,wetTarget:target,radius:256,resolution:128});
    const camera=new T.PerspectiveCamera();camera.updateMatrixWorld(true);
    const points=[[-80,0,-48],[80,0,-48],[-80,40,-48],[270,0,-48]];
    const positions=T.uniformArray(points.map(p=>new T.Vector3(...p)),'vec3');
    const mat=new T.MeshBasicNodeMaterial({toneMapped:false});
    mat.fragmentNode=T.vec4(field.sample(positions.element(T.int(T.uv().x.mul(points.length)))),0,1);
    const quad=new T.QuadMesh(mat),output=new T.RenderTarget(points.length,1,{type:T.FloatType,depthBuffer:false});
    const saved=T.RendererUtils.saveRendererState(renderer),context=renderer.contextNode,measurements=[],checks=[];
    const check=(name,pass)=>checks.push({name,pass:!!pass});
    const sample=async(name)=>{
        renderer.contextNode=T.context({});renderer.setMRT(null);renderer.setRenderTarget(output);await quad.renderAsync(renderer);
        const pixels=await renderer.readRenderTargetPixelsAsync(output,0,0,points.length,1);
        const values=points.map((_,i)=>Array.from(pixels.slice(i*4,i*4+2)));
        check(name+' contains finite values',values.flat().every(Number.isFinite));
        measurements.push({name,values,captures:field.stats.captures});return values;
    };
    try{
        await field.prepare(renderer,camera,0);await field.prepare(renderer,camera,30);
        const dry=await sample('dry cloud cell despite rainy global target');
        check('dry cells do not accumulate water',dry.flat().every(v=>v===0));
        supply.value=1;await field.prepare(renderer,camera,30,{force:true});
        const arrival=await sample('rain arrival');
        check('rain arrives before water accumulates',arrival[0].every(v=>v===0));
        const startCaptures=field.stats.captures,subframes=[];
        for(const dt of [.05,.1,.15]){await field.prepare(renderer,camera,30+dt);subframes.push((await sample('subframe '+dt))[0]);}
        check('wetness evolves between captures',field.stats.captures===startCaptures
            &&subframes[0][0]>0&&subframes[1][0]>subframes[0][0]&&subframes[2][0]>subframes[1][0]);
        check('thin wetness precedes pooled water',subframes.every(v=>v[0]>v[1]*3));
        await field.prepare(renderer,camera,60);
        const soaked=await sample('sustained rain');
        check('rain fills exposed columns',soaked[0][0]>.8&&soaked[0][1]>.4);
        check('nearby dry column stays dry',soaked[1].every(v=>v===0));
        check('upper surfaces share local rainfall',soaked[0].every((v,i)=>v===soaked[2][i]));
        check('outside the tracked footprint remains dry',soaked[3].every(v=>v===0));
        supply.value=0;await field.prepare(renderer,camera,60,{force:true});
        const stopped=await sample('cloud has passed');
        check('same-time refresh does not add or remove water',stopped[0].every((v,i)=>Math.abs(v-soaked[0][i])<.001));
        await field.prepare(renderer,camera,65);
        const drying=await sample('drying after five seconds');
        check('puddles persist and dry gradually',drying[0][0]>.7&&drying[0][0]<soaked[0][0]
            &&drying[0][1]>.35&&drying[0][1]<soaked[0][1]);
        camera.position.x=100;camera.updateMatrixWorld(true);await field.prepare(renderer,camera,65);
        const moved=await sample('camera leaves guard area');
        check('camera recenter preserves overlapping water history',moved[0].every((v,i)=>Math.abs(v-drying[0][i])<.001));
        check('newly tracked dry columns start dry',moved[3].every(v=>v===0));
        await field.prepare(renderer,camera,10);
        const rewound=await sample('time rewind');
        check('time rewind clears future water history',rewound.flat().every(v=>v===0));
        return {pass:checks.every(c=>c.pass),checks,measurements,stats:{...field.stats}};
    }finally{
        renderer.contextNode=context;T.RendererUtils.restoreRendererState(renderer,saved);
        field.dispose();output.dispose();mat.dispose();_eanpaTest.paused=wasPaused;
    }
})()
