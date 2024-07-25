import Bottleneck from 'bottleneck';
import * as dotenv from 'dotenv';
import { FileHandle, mkdir, open } from 'fs/promises';
dotenv.config();
const key = process.env.STARTGG_API_KEY;

const limiter = new Bottleneck({
  minTime: 60000 / 75,
});

async function wrappedFetch(
  input: URL | RequestInfo,
  init?: RequestInit | undefined,
): Promise<Response> {
  const response = await fetch(input, init);
  if (!response.ok) {
    throw response.status;
  }

  return response;
}

async function fetchGql(query: string, variables: any, timeoutMs?: number) {
  if (timeoutMs) {
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        console.log(`Retrying after ${timeoutMs / 1000} seconds.`);
        resolve();
      }, timeoutMs);
    })
  }

  try {
    const response = await limiter.schedule(() =>
      wrappedFetch('https://api.start.gg/gql/alpha', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      }),
    );
    const json = await response.json();
    if (json.errors) {
      throw new Error(json.errors[0].message);
    }
    return json.data;
  } catch (e: any) {
    if (e === 501 || e === 502 || e === 503 || e === 504) {
      return fetchGql(query, variables, timeoutMs ? timeoutMs * 2 : 1000);
    }
  }
}

// 1007910
const EVENT_ENTRANTS_QUERY = `
  query EventEntrantsQuery($id: ID, $page: Int) {
    event(id: $id) {
      entrants(query: {page: $page, perPage: 332}) {
        pageInfo {
          totalPages
        }
        nodes {
          id
          participants {
            player {
              gamerTag
              user {
                genderPronoun
              }
            }
          }
        }
      }
    }
  }
`;
type ApiEntrants = {
  pageInfo: {
    totalPages: number;
  },
  nodes: {
    id: number,
    participants: [{
      player: {
        gamerTag: string;
        user: {
          genderPronoun: string | null;
        } | null,
      },
    }],
  }[],
};
type Entrant = {
  id: number;
  name: string;
  pronouns: string;
};
const EVENT_SETS_QUERY = `
  query EventSetsQuery($id: ID, $page: Int, $entrantIds: [ID]) {
    event(id: $id) {
      sets(page: $page, perPage: 142, filters: {entrantIds: $entrantIds, state: 3}) {
        pageInfo {
          totalPages
        }
        nodes {
          displayScore
          slots {
            entrant {
              id
              initialSeedNum
            }
          }
          winnerId
        }
      }
    }
  }
`;
type ApiSets = {
  pageInfo: {
    totalPages: number;
  }
  nodes: {
    displayScore: string;
    slots: {
      entrant: {
        id: number;
        initialSeedNum: number;
      }
    }[],
    winnerId: number;
  }[],
};
const SEED_FLOORS = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073];
function getSeedTier(seed: number) {
  for (let i = 0; i < SEED_FLOORS.length; i++) {
    if (SEED_FLOORS[i] === seed) {
      return i;
    } else if (SEED_FLOORS[i] > seed) {
      return i - 1;
    }
  }
  throw 'asdf';
}
async function getEvent(id: number, tournamentName: string, eventName: string, startAt: number, fh: FileHandle) {
  const idToEntrant = new Map<number, Entrant>();
  const sheOrHerIds = new Set<number>();
  let entrantsPage = 1;
  let nextEntrants: ApiEntrants;
  do {
    console.log(`event id: ${id}, entrants page ${entrantsPage}`)
    nextEntrants = (await fetchGql(EVENT_ENTRANTS_QUERY, { id, page: entrantsPage })).event.entrants;
    for (const entrant of nextEntrants.nodes) {
      const genderPronoun = entrant.participants[0].player.user?.genderPronoun;
      idToEntrant.set(
        entrant.id,
        {
          id: entrant.id,
          name: entrant.participants[0].player.gamerTag,
          pronouns: genderPronoun ?? '',
        },
      );
      if (genderPronoun) {
        const lowerCase = genderPronoun.toLowerCase();
        const anyAll = lowerCase.includes('any') || lowerCase.includes('all');
        const heHim = lowerCase.includes('he') || lowerCase.includes('him');
        const theyThem = lowerCase.includes('they') || lowerCase.includes('them');
        if (
          lowerCase.includes('she') ||
          lowerCase.includes('her') ||
          (!heHim && (anyAll || theyThem))
        ) {
          sheOrHerIds.add(entrant.id);
        }
      }
    }
    entrantsPage++;
  } while (entrantsPage <= nextEntrants.pageInfo.totalPages);
  if (sheOrHerIds.size > 0) {
    const entrantIds = Array.from(sheOrHerIds.keys());
    let setsPage = 1;
    let nextSets: ApiSets;
    do {
      console.log(`event id: ${id}, sets page ${setsPage}, entrantIds: [${entrantIds}]`);
      nextSets = (await fetchGql(EVENT_SETS_QUERY, { id, page: setsPage, entrantIds })).event.sets;
      for (const set of nextSets.nodes) {
        if (set.displayScore === 'DQ') {
          continue;
        }
        const slot0SeedTier = getSeedTier(set.slots[0].entrant.initialSeedNum);
        const slot1SeedTier = getSeedTier(set.slots[1].entrant.initialSeedNum);
        if (slot0SeedTier === slot1SeedTier) {
          continue;
        }

        const slot0Less = set.slots[0].entrant.initialSeedNum < set.slots[1].entrant.initialSeedNum;
        const lowerSeedI = slot0Less ? 1 : 0;
        const lowerSeedId = set.slots[lowerSeedI].entrant.id;
        if (lowerSeedId === set.winnerId && sheOrHerIds.has(lowerSeedId)) {
          const lowerSeed = set.slots[lowerSeedI].entrant.initialSeedNum;
          const higherSeed = set.slots[slot0Less ? 0 : 1].entrant.initialSeedNum;
          const entrant = idToEntrant.get(lowerSeedId)!
          const opponent = idToEntrant.get(set.slots[slot0Less ? 0 : 1].entrant.id)!;
          console.log(`${entrant.name} (${entrant.pronouns}), ${lowerSeed} seed upset ${opponent.name} (${opponent.pronouns}), ${higherSeed} seed (factor: ${getSeedTier(lowerSeed) - getSeedTier(higherSeed)}) at ${tournamentName} - ${eventName}`);
          await fh.write(`"${entrant.name}","${entrant.pronouns}",${lowerSeed},"${opponent.name}","${opponent.pronouns}",${higherSeed},${getSeedTier(lowerSeed) - getSeedTier(higherSeed)},"${tournamentName}","${eventName}",${startAt * 1000}\n`);
        }
      }
      setsPage++;
    } while (setsPage <= nextSets.pageInfo.totalPages);
  }
}

const TOURNAMENTS_QUERY = `
  query TournamentsQuery($page: Int) {
    tournaments(
      query: {page: $page, perPage: 500, filter: {past: true, videogameIds: [1]}}
    ) {
      pageInfo {
        totalPages
      }
      nodes {
        name
        startAt
        events(filter: {type: [1], videogameId: [1]}) {
          id
          name
        }
      }
    }
  }
`;
type ApiTournaments = {
  pageInfo: {
    totalPages: number;
  }
  nodes: {
    name: string;
    startAt: number;
    events: {
      id: number;
      name: string;
    }[],
  }[],
};
async function getTournaments() {
  await mkdir('csv', { recursive: true });
  const fh = await open(`csv/${Date.now()}.csv`, 'w+');
  let tournamentPage = 1;
  let nextTournaments: ApiTournaments;
  do {
    console.log(`tournaments page ${tournamentPage}`);
    nextTournaments = (await fetchGql(TOURNAMENTS_QUERY, { page: tournamentPage })).tournaments;
    for (const tournament of nextTournaments.nodes) {
      for (const event of tournament.events) {
        await getEvent(event.id, tournament.name, event.name, tournament.startAt, fh);
      }
    }
    tournamentPage++;
  } while (tournamentPage <= nextTournaments.pageInfo.totalPages);
}

if (key) {
  console.log(key);
  getTournaments();
} else {
  console.log('Set STARTGG_API_KEY="asdf" in .env');
}
