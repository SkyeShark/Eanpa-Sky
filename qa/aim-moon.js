(() => {
    const dir=_asteroidMoon.position.clone().sub(_c.position).normalize();
    _look.yaw=Math.atan2(-dir.x,-dir.z);_look.pitch=Math.asin(dir.y);_look.vyaw=0;_look.vpitch=0;
    _c.fov=32;_c.updateProjectionMatrix();_eanpaTest.paused=false;
    return {pitch:_look.pitch,yaw:_look.yaw,moon:_shieldworldMoonStats};
})()
