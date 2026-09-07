(() => {
    let best;
    // Find a steep exposed part of the actual authored height field.
    const bounds=_terrain.terrainBounds;
    for(let x=80;x<=bounds.maxX-24;x+=8)for(let z=80;z<=bounds.maxZ-24;z+=8){
        const s=_terrain.sampleTerrain(x,z);
        if(s.inside&&s.grade>.5&&s.grade<1.6&&(!best||s.grade>best.grade))best={...s,normal:{...s.normal}};
    }
    if(!best)throw new Error('No steep terrain view found');
    const p=new THREE.Vector3(best.x,best.height,best.z);
    const n=new THREE.Vector3(best.normal.x,best.normal.y,best.normal.z);
    const eye=p.clone().addScaledVector(n,9).add(new THREE.Vector3(0,1.5,0));
    eye.y=Math.max(eye.y,_terrain.heightAt(eye.x,eye.z)+1.82);
    _c.position.copy(eye);
    Object.assign(_movementState,{physicalEyeY:eye.y,verticalVelocity:0,grounded:false,bobOffset:0,stepViewOffset:0});
    const dir=p.sub(eye).normalize();
    _look.yaw=Math.atan2(-dir.x,-dir.z);_look.pitch=Math.asin(dir.y);_look.vyaw=0;_look.vpitch=0;
    _c.fov=52;_c.updateProjectionMatrix();
    _eanpaTest.pauseAfterFrame=true;_eanpaTest.paused=false;
    return {surface:best,eye:eye.toArray()};
})()
