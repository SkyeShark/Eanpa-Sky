(() => {
    const p = _c.position;
    p.set(0,(_terrain.heightAt?.(0,96)??0)+1.82,96);
    Object.assign(_movementState,{physicalEyeY:p.y,verticalVelocity:0,grounded:true,bobOffset:0,stepViewOffset:0});
    _look.yaw=0;_look.pitch=.035;_look.vyaw=0;_look.vpitch=0;
    _c.fov=52;_c.updateProjectionMatrix();
    dispatchEvent(new Event('resize'));
    _eanpaTest.paused=false;
    return {camera:p.toArray(),viewport:[innerWidth,innerHeight]};
})()
