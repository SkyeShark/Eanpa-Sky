(() => {
    const dir=_sky.sunDir;
    _look.yaw=Math.atan2(-dir.x,-dir.z);_look.pitch=Math.asin(dir.y);_look.vyaw=0;_look.vpitch=0;
    _c.fov=52;_c.updateProjectionMatrix();_eanpaTest.paused=false;
    return {pitch:_look.pitch,yaw:_look.yaw};
})()
