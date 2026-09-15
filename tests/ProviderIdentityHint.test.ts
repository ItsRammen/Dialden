import {test, expect} from 'bun:test'
import {tmdbIdentityHint} from '../src/services/metadata/ProviderIdentityHint'
test('accepts explicit TMDB hints but never guesses conflicting or malformed IDs',()=>{
 expect(tmdbIdentityHint('Film (2024) {tmdb-123}')).toEqual({id:'123',invalid:false})
 expect(tmdbIdentityHint('Show {TMDB:123} {tmdb-123}')).toEqual({id:'123',invalid:false})
 for(const title of ['X {tmdb-1} {tmdb-2}','X {tmdb-0}','X {tmdb-123oops}','X {tmdb-99999999999999999999}'])
  expect(tmdbIdentityHint(title).invalid).toBe(true)
 expect(tmdbIdentityHint('Film {edition-Extended}')).toEqual({id:null,invalid:false})
})
