import { afterEach, describe, expect, test } from 'bun:test'
import { createCollectionLibraryPageController } from '../src/controllers/CollectionLibraryPageController'
import { MediaRepository } from '../src/repositories/MediaRepository'
import { CollectionLibraryService } from '../src/services/CollectionLibraryService'
import type { CollectionUpsertInput, LibraryKind } from '../src/types'

function collectionInput(
  kind: Extract<LibraryKind, 'tv' | 'movie'>,
  index: number,
  prefix: string
): CollectionUpsertInput {
  const title = `${prefix} ${String(index).padStart(3, '0')}`
  return {
    rootId: kind,
    libraryKind: kind,
    identityKey: `${kind}:${index}`,
    sourceTitle: title,
    parsedTitle: title,
    year: 2020,
  }
}

function pageController(repository: MediaRepository) {
  return createCollectionLibraryPageController({
    library: new CollectionLibraryService(repository),
    metadata: {
      async confirmMatch() {
        return null
      },
      async retryCollection() {
        return null
      },
    },
  })
}

describe('collection library pagination', () => {
  const repositories: MediaRepository[] = []

  afterEach(async () => {
    await Promise.all(repositories.splice(0).map((repository) => repository.close()))
  })

  test('review categories are disjoint and combine with media type and search', async () => {
    const repository = new MediaRepository(':memory:')
    repositories.push(repository)
    await repository.initialize()
    const [unmatched, missing, conflict, approval, allowed, pg] = await repository.upsertCollections([
      collectionInput('movie', 1, 'Find Film'), collectionInput('movie', 2, 'Rate Film'),
      collectionInput('tv', 3, 'Rate Show'), collectionInput('tv', 4, 'Approve Show'),
      collectionInput('tv', 5, 'Ready Show'), collectionInput('tv', 6, 'Guidance Show'),
    ])
    await repository.updateCollectionMetadata(unmatched!.id, { provider: 'tmdb', externalId: null, status: 'ambiguous' })
    for (const [item, ratingStatus, certification] of [
      [missing!, 'missing', null], [conflict!, 'ambiguous', null], [approval!, 'resolved', 'G'], [allowed!, 'resolved', 'G'], [pg!, 'resolved', 'TV-PG'],
    ] as const) await repository.updateCollectionMetadata(item.id, { provider: 'tmdb', externalId: String(item.id), status: 'matched', ratingStatus, certification })
    await repository.updateCollectionOverride(missing!.id, 'allow')
    await repository.updateCollectionPolicy(allowed!.id, 'allow', 'test')
    await repository.updateCollectionPolicy(pg!.id, 'review', 'rating_requires_review')
    expect(await repository.getCollectionReviewCounts()).toEqual({ all: 4, match: 1, rating: 2, approval: 1 })
    expect(await repository.getCollectionReviewCounts({ kind: 'movie' })).toEqual({ all: 2, match: 1, rating: 1, approval: 0 })
    expect(await repository.getCollectionReviewCounts({ search: 'Rate' })).toEqual({ all: 2, match: 0, rating: 2, approval: 0 })
    expect((await repository.getCollections({ reviewStage: 'all', kind: 'movie', search: 'Rate' })).map(c => c.id)).toEqual([missing!.id])
    expect((await repository.getCollections({ reviewStage: 'approval' })).map(c => c.id)).toEqual([approval!.id])
    expect((await repository.getCollections({ reviewStage: 'metadata' })).map(c => c.id).sort()).toEqual([unmatched!.id, missing!.id, conflict!.id].sort())
    const markup = await (await pageController(repository).request('/library/review?stage=rating&kind=movie&search=Rate')).text()
    expect(markup).toContain('Needs rating (1)')
    expect(markup).toContain('Rate Film')
    expect(markup).not.toContain('Rate Show 003')
    expect(markup).toContain('Review rating')
    expect(markup).toContain('Parent decision options')
    expect(markup).toContain('href="/library/review?stage=match&amp;kind=movie&amp;search=Rate"')
    expect(markup).toContain('href="/library/review?stage=rating&amp;kind=tv&amp;search=Rate"')
    expect((await repository.getCollectionById(missing!.id))?.parentOverride).toBe('allow')
  })

  test('review pagination and bulk return paths retain all filters', async () => {
    const repository = new MediaRepository(':memory:')
    repositories.push(repository)
    await repository.initialize()
    await repository.upsertCollections(Array.from({ length: 110 }, (_, i) => collectionInput('movie', i, 'Waiting Film')))
    const markup = await (await pageController(repository).request('/library/review?stage=match&kind=movie&search=Waiting&page=2')).text()
    expect(markup).toContain('Missing match (110)')
    expect(markup).toContain('Waiting Film 050')
    expect(markup).not.toContain('Waiting Film 049')
    expect(markup).toContain('href="/library/review?stage=match&amp;kind=movie&amp;search=Waiting"')
    expect(markup).toContain('href="/library/review?stage=match&amp;kind=movie&amp;search=Waiting&amp;page=3"')
    expect(markup).toContain('value="/library/review?stage=match&amp;kind=movie&amp;search=Waiting&amp;page=2"')
    const empty = await (await pageController(repository).request('/library/review?stage=approval&kind=tv&search=%22%3E%3Cscript%3E')).text()
    expect(empty).toContain('No collections match these review filters.')
    expect(empty).toContain('Show all review issues')
    expect(empty).not.toContain('value=""><script>')
  })

  test('TV and movie pages expose collections after the old 250-row ceiling', async () => {
    const repository = new MediaRepository(':memory:')
    repositories.push(repository)
    await repository.initialize()
    await repository.upsertCollections([
      ...Array.from({ length: 255 }, (_, index) =>
        collectionInput('tv', index, 'TV Title')
      ),
      ...Array.from({ length: 255 }, (_, index) =>
        collectionInput('movie', index, 'Movie Title')
      ),
    ])
    const app = pageController(repository)

    const tvResponse = await app.request('/library/tv?page=6')
    const movieResponse = await app.request('/library/movies?page=6')
    const tvMarkup = await tvResponse.text()
    const movieMarkup = await movieResponse.text()

    expect(tvResponse.status).toBe(200)
    expect(movieResponse.status).toBe(200)
    expect(tvMarkup).toContain('TV Title 254')
    expect(movieMarkup).toContain('Movie Title 254')
    expect(tvMarkup).toContain('Page 6')
    expect(movieMarkup).toContain('Page 6')
  })

  test('late approval and metadata review rows are filtered before pagination', async () => {
    const repository = new MediaRepository(':memory:')
    repositories.push(repository)
    await repository.initialize()
    const collections = await repository.upsertCollections(
      Array.from({ length: 261 }, (_, index) =>
        collectionInput('tv', index, 'Review Candidate')
      )
    )
    for (const collection of collections.slice(0, -1)) {
      await repository.updateCollectionMetadata(collection.id, { provider: 'tmdb', externalId: String(collection.id), status: 'matched', ratingStatus: 'resolved', certification: 'G' })
      await repository.updateCollectionPolicy(
        collection.id,
        'allow',
        'test_allowed'
      )
    }
    const lateCollection = collections.at(-1)
    if (!lateCollection) throw new Error('Expected a late collection')
    await repository.updateCollectionMetadata(lateCollection.id, {
      provider: 'tmdb',
      externalId: null,
      status: 'unmatched',
      ratingStatus: 'missing',
      error: 'No reliable match',
    })
    const app = pageController(repository)

    const approvalResponse = await app.request('/library/review')
    const metadataResponse = await app.request('/library/review/metadata')
    const approvalMarkup = await approvalResponse.text()
    const metadataMarkup = await metadataResponse.text()

    expect(approvalResponse.status).toBe(200)
    expect(metadataResponse.status).toBe(200)
    expect(approvalMarkup).toContain('Review Candidate 260')
    expect(metadataMarkup).toContain('Review Candidate 260')
    expect(approvalMarkup).toContain('All issues (1)')
    expect(metadataMarkup).toContain('All metadata issues (1)')
  })

  test('previous and next links preserve approval and search filters', async () => {
    const repository = new MediaRepository(':memory:')
    repositories.push(repository)
    await repository.initialize()
    await repository.upsertCollections(
      Array.from({ length: 255 }, (_, index) =>
        collectionInput('tv', index, 'Filtered Title')
      )
    )
    const app = pageController(repository)

    const response = await app.request(
      '/library/tv?status=review&search=Filtered%20Title&page=5'
    )
    const markup = await response.text()

    expect(markup).toContain(
      'href="/library/tv?status=review&amp;search=Filtered+Title&amp;page=4"'
    )
    expect(markup).toContain(
      'href="/library/tv?status=review&amp;search=Filtered+Title&amp;page=6"'
    )
    expect(markup).toContain('Page 5')
  })
})
