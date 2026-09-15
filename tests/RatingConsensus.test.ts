import {test, expect} from 'bun:test'
import {evaluateRatingConsensus} from '../src/policy/RatingConsensus'
import {DEFAULT_KIDS_7_POLICY} from '../src/policy/PolicyEngine'
const ratings=(...labels:string[])=>labels.map(certification=>({region:'US',certification}))
test('consensus preserves conflict but resolves unanimous profile decisions',()=>{
 expect(evaluateRatingConsensus(DEFAULT_KIDS_7_POLICY,ratings('TV-Y7','TV-G'),['US'])).toMatchObject({decision:'allow',certification:null})
 expect(evaluateRatingConsensus(DEFAULT_KIDS_7_POLICY,ratings('R','NC-17'),['US'])).toMatchObject({decision:'block'})
 expect(evaluateRatingConsensus(DEFAULT_KIDS_7_POLICY,ratings('G','PG'),['US'])).toBeNull()
 expect(evaluateRatingConsensus(DEFAULT_KIDS_7_POLICY,ratings('G','UNKNOWN LABEL'),['US'])).toBeNull()
})
test('custom profiles and first region remain authoritative',()=>{
 const custom={...DEFAULT_KIDS_7_POLICY, rules:{allow:['TV-G'],review:['TV-Y7'],block:['R']}}
 expect(evaluateRatingConsensus(custom,ratings('TV-Y7','TV-G'),['US'])).toBeNull()
 expect(evaluateRatingConsensus(DEFAULT_KIDS_7_POLICY,[...ratings('G','PG'),{region:'CA',certification:'G'}],['US','CA'])).toBeNull()
})
