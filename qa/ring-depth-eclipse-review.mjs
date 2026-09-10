// Uses the one existing automated page; never launches a browser or captures input.
// node qa/ring-depth-eclipse-review.mjs [artifact-directory]
import {connect} from './cdp.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
const directory=process.argv[2]??'artifacts/ring-depth-eclipse',c=await connect();
const samples=[
    {name:'reverse-detail',hours:11.9,pitch:.85,yaw:Math.PI,fov:32},
    {name:'morning-forward',hours:10.5,pitch:.55,yaw:0,fov:62},
    {name:'morning-reverse',hours:10.5,pitch:.55,yaw:Math.PI,fov:62},
    {name:'ingress-forward',hours:11.47,pitch:.28,yaw:0,fov:62},
    {name:'ingress-reverse',hours:11.47,pitch:.28,yaw:Math.PI,fov:62},
    {name:'total-forward',hours:12,pitch:.55,yaw:0,fov:62},
    {name:'total-reverse',hours:12,pitch:.55,yaw:Math.PI,fov:62},
    {name:'egress-forward',hours:12.47,pitch:.28,yaw:0,fov:62},
    {name:'night-glint',hours:0,pitch:1.3,yaw:0,fov:32,glint:true},
];
try{
    await mkdir(directory,{recursive:true});
    await c.evaluate(`(()=>{
        if(!new URL(location.href).searchParams.has('automated')||document.pointerLockElement)throw new Error('Expected an automated page without pointer capture');
        if(document.getElementById('boot').style.display!=='none'||document.getElementById('skybox').value!=='ringworld')throw new Error('Load Ringworld before review');
        if(globalThis.__ringDepthRestore)throw new Error('Reload to remove temporary diagnostic patches');
        const cloud=document.getElementById('cloud-type');cloud.value='clear';cloud.dispatchEvent(new Event('change',{bubbles:true}));
        document.getElementById('weather').value='none';__eanpaWeatherByScene.get(_c.parent).setWeather('none');
        _sky.setClouds('clear');
        document.getElementById('cycle').checked=false;
    })()`);
    const captures=[];
    for(const view of samples){
        const state=await c.evaluate(`(async()=>{
            const v=${JSON.stringify(view)},tod=document.getElementById('tod');
            tod.value=v.hours;tod.dispatchEvent(new Event('input',{bubbles:true}));
            _sky.setTime(v.hours);
            _c.position.set(0,1.82,96);_c.rotation.set(v.pitch,v.yaw,0,'YXZ');_c.fov=v.fov;
            if(v.glint){
                const T=THREE,center=_ringworld.arcLight.center.value;let best=-1,aim=null;
                for(let i=0;i<720;i++){
                    const a=i*Math.PI/360,n=new T.Vector3(0,-Math.cos(a),-Math.sin(a));
                    const p=center.clone().addScaledVector(n,-5000),view=_c.position.clone().sub(p).normalize();
                    if(n.dot(_sky.sunDir)<=0||n.dot(view)<=0)continue;
                    const score=n.dot(view.add(_sky.sunDir).normalize());
                    if(score>best){best=score;aim=p;}
                }
                if(aim)_c.lookAt(aim);
            }
            _c.updateProjectionMatrix();_c.updateMatrixWorld(true);
            Object.assign(_look,{pitch:_c.rotation.x,yaw:_c.rotation.y,vpitch:0,vyaw:0});
            Object.assign(_movementState,{physicalEyeY:1.82,verticalVelocity:0,grounded:true,bobOffset:0,stepViewOffset:0});
            // Let the serialized environment refresh settle too, so chrome
            // and ambient fill represent this time rather than the last view.
            _eanpaTest.pauseAfterFrame=false;_eanpaTest.paused=false;
            await new Promise(r=>setTimeout(r,1800));_eanpaTest.pauseAfterFrame=true;
            while(!_eanpaTest.paused)await new Promise(r=>setTimeout(r,20));
            for(let i=0;i<5;i++){await new Promise(requestAnimationFrame);await _reflectionPipeline.render();}
            await new Promise(requestAnimationFrame);
            const errors=[...document.body.children].filter(e=>e.style?.zIndex==='99').map(e=>e.textContent).filter(Boolean);
            if(errors.length)throw new Error(JSON.stringify(errors));
            return {hours:_sky.state.hours,center:_ringworld.arcLight.center.value.toArray(),sun:_sky.sunDir.toArray(),
                observer:_c.position.toArray(),look:_c.rotation.toArray(),cameraNear:_c.near,
                cloud:_sky.state.preset,cloudDensity:_sky.uniforms.finalMul.value,
                weatherTransition:!!_weather.diagnostics?.transition?.active,
                solar:_ringEclipse,spatial:!!_sky._solarOcclusion,errors};
        })()`);
        const shot=await c.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
        await writeFile(`${directory}/${view.name}.png`,Buffer.from(shot.data,'base64'));
        captures.push({...view,...state});console.log(JSON.stringify({capture:view.name,solar:state.solar}));
    }
    const gpu=await c.evaluate(`(async()=>{
        const {ringSolarVisibility}=await import('./engine/ring_eclipse.js');
        const T=THREE,r=_reflectionPipeline.pipeline.renderer,points=[];
        for(const x of [-700,-500,-250,0,250,500,700])for(const y of [0,25,500])points.push(new T.Vector3(x,y,96));
        const center=_ringworld.arcLight.center.value;
        for(const z of [-4000,-2000,2000,4000])for(const x of [-450,0,450]){
            points.push(new T.Vector3(x,center.y-Math.sqrt(5000**2-z*z)+2,center.z+z));
        }
        const p=T.uniformArray(points,'vec3').element(T.screenCoordinate.x.floor().toInt());
        const material=new T.MeshBasicNodeMaterial({depthTest:false,depthWrite:false,fog:false});
        material.colorNode=T.vec3(_ringworld.solarVisibilityNode(p));material.toneMapped=false;
        const quad=new T.QuadMesh(material),target=new T.RenderTarget(points.length,1,{type:T.HalfFloatType,depthBuffer:false});
        const saved=T.RendererUtils.saveRendererState(r),context=r.contextNode,hours=_sky.state.hours,checks=[];
        try{
            r.contextNode=T.context({eanpaReflectionSurfacePass:false});r.setMRT(null);r.setRenderTarget(target);
            r.toneMapping=T.NoToneMapping;r.outputColorSpace=T.LinearSRGBColorSpace;
            for(const h of [10.5,11.44,11.47,11.5,12,12.47,13,0]){
                _sky.setTime(h);_ringworld.update(_sky.uniforms.time.value);
                await quad.renderAsync(r);
                const data=await r.readRenderTargetPixelsAsync(target,0,0,points.length,1);
                let maxError=0,partial=0;
                for(let i=0;i<points.length;i++){
                    const expected=ringSolarVisibility(points[i],_sky.sunDir,{center}),actual=T.DataUtils.fromHalfFloat(data[i*4]);
                    maxError=Math.max(maxError,Math.abs(expected-actual));if(expected>0&&expected<1)partial++;
                }
                checks.push({hours:h,points:points.length,partial,maxError});
            }
        }finally{
            _sky.setTime(hours);_ringworld.update(_sky.uniforms.time.value);
            r.contextNode=context;T.RendererUtils.restoreRendererState(r,saved);material.dispose();target.dispose();
        }
        return {pass:checks.every(s=>s.maxError<.001)&&checks.some(s=>s.partial>0),checks};
    })()`);
    await writeFile(`${directory}/checks.json`,JSON.stringify({date:new Date().toISOString(),captures,gpu},null,2));
    console.log(JSON.stringify(gpu));if(!gpu.pass)process.exitCode=1;
}finally{c.close()}
