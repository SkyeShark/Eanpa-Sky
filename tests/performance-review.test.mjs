import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

test('benchmark CLI rejects rendering failures, reports only real upgrades, and always releases owned resources',async()=>{
    const {stdout}=await promisify(execFile)(process.execPath,
        ['--experimental-vm-modules',fileURLToPath(new URL('./fixtures/performance-review-faults.mjs',import.meta.url))],
        {windowsHide:true,timeout:15000});
    const results=JSON.parse(stdout),byName=Object.fromEntries(results.map(r=>[r.scenario,r]));
    assert.equal(byName.control.reportValid,true);
    assert.equal(byName.control.error,null);
    assert.ok(byName.control.upgrade.durationMs>0);
    for(const name of ['absent-stream','disabled-stream']){
        assert.equal(byName[name].reportValid,true,name);
        assert.equal(byName[name].measurementStarted,false,name);
        assert.equal(byName[name].upgrade,null,name);
    }
    assert.match(byName['report-write-fails'].causes.join('\n'),/ENOSPC/);
    assert.match(byName['connection-close-fails'].causes.join('\n'),/connection cleanup failure/);
    for(const name of ['startup-fails','invalid-startup','incomplete-warmup','initial-frame-failure',
        'late-frame-failure','late-pipeline-failure','late-cloud-failure','late-console-error']){
        assert.equal(byName[name].reportValid,false,name);
        assert.equal(byName[name].exitCode,1,name);
    }
    for(const result of results){
        assert.equal(result.childrenExited,true,result.scenario);
        assert.equal(result.removed,true,result.scenario);
        assert.equal(result.events.at(-1),'profile-remove',result.scenario);
    }
});
