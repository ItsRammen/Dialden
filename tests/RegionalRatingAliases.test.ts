import {test, expect} from 'bun:test'
import {evaluatePolicy, DEFAULT_KIDS_7_POLICY} from '../src/policy/PolicyEngine'
test('regional labels use their own country definitions under Kids 7',()=>{
 for(const [region,certification,decision] of [['FR','TP','allow'],['CA','C','allow'],['CA','C8','block'],['CA','C8+','block'],['CA','14+','block']] as const){
  expect(evaluatePolicy(DEFAULT_KIDS_7_POLICY,{matchStatus:'matched',certification,certificationRegion:region}).decision).toBe(decision)
 }
 expect(evaluatePolicy(DEFAULT_KIDS_7_POLICY,{matchStatus:'matched',certification:'TP',certificationRegion:'US'}).decision).toBe('review')
 expect(evaluatePolicy(DEFAULT_KIDS_7_POLICY,{matchStatus:'matched',certification:'TP+A',certificationRegion:'FR'}).decision).toBe('review')
})
test('a custom policy remains explicit',()=>{
 const profile={...DEFAULT_KIDS_7_POLICY,id:'custom',rules:{allow:['C8'],review:['TP'],block:['R']}}
 expect(evaluatePolicy(profile,{matchStatus:'matched',certification:'C8',certificationRegion:'CA'}).decision).toBe('allow')
 expect(evaluatePolicy(profile,{matchStatus:'matched',certification:'TP',certificationRegion:'FR'}).decision).toBe('review')
})
