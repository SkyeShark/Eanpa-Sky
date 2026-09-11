// GPU check: two distinct PBR receivers share native shadow-light uniforms,
// retain material values, and update filter dimensions across same-frame renders.
// Native light color/intensity follows Three's separate animation-frame cadence.
import {connect} from './cdp.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
const baseline=process.argv.includes('baseline'),identical=process.argv.includes('identical');
const expectedGroups=baseline&&!identical?2:1;
const c=await connect();
const output='artifacts/cpu-optimization-20260910/shadow-uniform-validation'+(baseline?'-baseline':'')+(identical?'-identical':'')+'.json';
try{
    const result=await c.evaluate(`(async()=>{
        const T=THREE,r=_reflectionPipeline.pipeline.renderer;
        _eanpaTest.paused=false;_eanpaTest.pauseAfterFrame=true;
        while(!_eanpaTest.paused)await new Promise(done=>setTimeout(done,10));
        const state=T.RendererUtils.saveRendererState(r),context=r.contextNode,shadowType=r.shadowMap.type;
        const original=r._nodes.updateGroup,rows=[],groups=new Set();
        r._nodes.updateGroup=function(group){if(group.name==='render')groups.add(group);return original.call(this,group);};
        try{
            T.RendererUtils.resetRendererState(r);r.contextNode=T.context({});r.toneMapping=T.NoToneMapping;r.outputColorSpace=T.LinearSRGBColorSpace;
            for(const filter of ['PCF','PCFSoft','point']){
                const scene=new T.Scene(),camera=new T.OrthographicCamera(-1,1,1,-1,.1,10);camera.position.z=5;
                r.shadowMap.type=filter==='PCFSoft'?T.PCFSoftShadowMap:T.PCFShadowMap;
                const light=filter==='point'?new T.PointLight(0xffffff,2):new T.DirectionalLight(0xffffff,1);
                light.castShadow=true;light.position.set(0,0,3);light.shadow.mapSize.set(64,32);light.shadow.radius=1;
                scene.add(light);if(light.target)scene.add(light.target);
                const geometry=new T.PlaneGeometry(1,2),materials=[];
                for(let i=0;i<2;i++){
                    const material=new T.MeshStandardNodeMaterial({color:i?0x0000ff:0xff0000,roughness:1,metalness:0});
                    // Distinct shader graphs, like different host PBR materials.
                    if(i&&!${identical})material.colorNode=T.color(0x0000ff);
                    const mesh=new T.Mesh(geometry,material);mesh.position.x=i?.5:-.5;mesh.receiveShadow=true;scene.add(mesh);materials.push(material);
                }
                const a=new T.RenderTarget(2,1,{type:T.UnsignedByteType,depthBuffer:true}),b=a.clone();
                try{
                    r.setRenderTarget(a);await r.compileAsync(scene,camera);groups.clear();
                    const frame=r._nodes.nodeFrame.frameId;r.render(scene,camera);
                    const receiverGroups=[...groups].filter(g=>g.uniforms.some(u=>{const v=u.getValue();return v?.isVector2&&v.x===64&&v.y===32;}));
                    // Point filters still have distinct camera-depth uniforms
                    // per shader graph; this patch shares mapSize/radius only.
                    const expected=filter==='point'&&!${identical}?2:${expectedGroups};
                    if(receiverGroups.length!==expected)throw new Error(filter+': unexpected light/filter buffer count '+receiverGroups.length);
                    light.intensity*=.25;light.shadow.mapSize=new T.Vector2(32,16);light.shadow.radius=2;
                    r.setRenderTarget(b);r.clear(true,true,true);r.render(scene,camera);
                    if(frame!==r._nodes.nodeFrame.frameId)throw new Error('Renders crossed animation frames');
                    const values=receiverGroups[0].uniforms.map(u=>u.getValue());
                    if(!values.some(v=>v?.isVector2&&v.x===32&&v.y===16))throw new Error('Stale shadow dimensions');
                    const first=Array.from(await r.readRenderTargetPixelsAsync(a,0,0,2,1));
                    const sameFrame=Array.from(await r.readRenderTargetPixelsAsync(b,0,0,2,1));
                    if(first[0]<4||first[6]<4||first[0]<first[2]*4||first[6]<first[4]*4)throw new Error('Receiver material values were mixed');
                    // AnalyticLightNode explicitly updates intensity once per
                    // animation frame. Exercise that contract without forcing
                    // renderer internals or claiming an intra-frame light update.
                    while(r._nodes.nodeFrame.frameId===frame)await new Promise(requestAnimationFrame);
                    r.setRenderTarget(b);r.render(scene,camera);
                    const second=Array.from(await r.readRenderTargetPixelsAsync(b,0,0,2,1));
                    for(const index of [0,6])if(Math.abs(second[index]-first[index]*.25)>2)throw new Error('Stale light values between renders: '+JSON.stringify({filter,first,second}));
                    rows.push({filter,sharedReceiverBuffers:receiverGroups.length,first,sameFrame,nextFrame:second,
                        filterDimensionsUpdatedWithinOneFrame:true,lightIntensityUpdatedNextFrame:true});
                }finally{a.dispose();b.dispose();geometry.dispose();materials.forEach(m=>m.dispose());light.dispose();}
            }
            return {date:new Date().toISOString(),passed:true,rows};
        }finally{
            r._nodes.updateGroup=original;r.shadowMap.type=shadowType;T.RendererUtils.restoreRendererState(r,state);r.contextNode=context;
            _eanpaTest.paused=false;_eanpaTest.pauseAfterFrame=false;
        }
    })()`);
    await mkdir('artifacts/cpu-optimization-20260910',{recursive:true});
    await writeFile(output,JSON.stringify(result,null,2));
    console.log(JSON.stringify(result,null,2));
}catch(error){
    await mkdir('artifacts/cpu-optimization-20260910',{recursive:true});
    await writeFile(output,JSON.stringify({date:new Date().toISOString(),baseline,identical,passed:false,error:String(error)},null,2));
    throw error;
}finally{c.close();}
