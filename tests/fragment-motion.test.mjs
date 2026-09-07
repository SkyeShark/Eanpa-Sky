import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as T from '../vendor/three/three.core.js';
import {makeFragmentMotion} from '../engine/fragment_motion.js';

async function moonMeshes(){
    const b=await readFile(new URL('../assets/asteroid_cluster_v3.glb',import.meta.url));
    const jsonLength=b.readUInt32LE(12),g=JSON.parse(b.toString('utf8',20,20+jsonLength));
    const binaryStart=28+jsonLength;
    return g.nodes.filter(n=>n.mesh!==undefined).map(n=>{
        const a=g.accessors[g.meshes[n.mesh].primitives[0].attributes.POSITION],v=g.bufferViews[a.bufferView];
        const data=new Float32Array(a.count*3),stride=v.byteStride??12;
        for(let i=0;i<a.count;i++)for(let axis=0;axis<3;axis++)
            data[i*3+axis]=b.readFloatLE(binaryStart+(v.byteOffset??0)+(a.byteOffset??0)+i*stride+axis*4);
        const geometry=new T.BufferGeometry().setAttribute('position',new T.BufferAttribute(data,3));
        const mesh=new T.Mesh(geometry);mesh.applyMatrix4(new T.Matrix4().fromArray(n.matrix));return mesh;
    });
}

test('authored moon fragments retain positive clearance throughout motion and long time jumps',async()=>{
    const pieces=await moonMeshes(),motion=makeFragmentMotion(T,pieces);
    assert.ok(motion.stats.minimumEnvelopeClearance>=motion.stats.clearance-1e-6);
    for(let frame=0;frame<1200;frame++){
        motion.update(frame*83.417);
        for(let i=0;i<pieces.length;i++){
            assert.ok(pieces[i].position.distanceTo(motion.basePositions[i])<=motion.amplitudes[i]+1e-8);
            for(let j=i+1;j<pieces.length;j++)assert.ok(
                pieces[i].position.distanceTo(pieces[j].position)-motion.radii[i]-motion.radii[j]>=motion.stats.clearance-1e-6);
        }
    }
});

test('fragment bounds contain off-centre scaled geometry and preserve authored orientation',()=>{
    const geometry=new T.BoxGeometry(1,2,3).translate(2,0,0),p=new T.Mesh(geometry);
    p.scale.set(2,.5,1.2);p.rotation.set(.2,.3,.4);const orientation=p.quaternion.clone();
    const m=makeFragmentMotion(T,[p]);m.update(0);
    assert.ok(p.quaternion.angleTo(orientation)<1e-7);
    const position=geometry.getAttribute('position'),v=new T.Vector3();
    m.update(9000);
    for(let i=0;i<position.count;i++){
        v.fromBufferAttribute(position,i).multiply(p.scale).applyQuaternion(p.quaternion);
        assert.ok(v.length()<=m.radii[0]+1e-8);
    }
});
