(() => {
    const x=0,z=-64;
    const surface=_temple.walkSurfaceAt(x,z);
    _c.position.set(x,(surface?.height ?? 22)+1.82,z);
    _look.yaw=0;_look.pitch=0.34;_look.vyaw=0;_look.vpitch=0;
    _eanpaTest.paused=false;
    return {surface,camera:_c.position.toArray()};
})()
