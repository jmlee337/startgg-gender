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

async function retryFetch(url: string, timeoutMs?: number) {
  if (timeoutMs) {
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        console.log(`Retrying after ${timeoutMs / 1000} seconds: ${url}`);
        resolve();
      }, timeoutMs);
    })
  }

  try {
    const response = await wrappedFetch(url);
    const json = await response.json();
    if (!json?.entities) {
      return retryFetch(url, timeoutMs ? timeoutMs * 2 : 1000);
    }
    return json.entities;
  } catch (e: any) {
    if (e === 501 || e === 502 || e === 503 || e === 504) {
      return retryFetch(url, timeoutMs ? timeoutMs * 2 : 1000);
    }
  }
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

const SEED_FLOORS = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073];
function getSeedTier(seed: number) {
  for (let i = 0; i < SEED_FLOORS.length; i++) {
    if (SEED_FLOORS[i] === seed) {
      return i;
    } else if (SEED_FLOORS[i] > seed) {
      return i - 1;
    }
  }
  return null;
}
type Tournament = {
  slug: string;
  name: string;
  startAt: number;
};
type Entrant = {
  id: number;
  name: string;
  pronouns: string;
  seed: number;
  slug: string;
};
const TOURNAMENT_PARTICIPANTS_QUERY = `
  query TournamentParticipantsQuery($slug: String, $eventIds: [ID], $page: Int) {
    tournament(slug: $slug) {
      participants(query: {page: $page, perPage: 499, filter: {eventIds: $eventIds}}) {
        pageInfo {
          totalPages
        }
        nodes {
          player {
            id
            user {
              genderPronoun
              slug
            }
          }
        }
      }
    }
  }
`;
type ApiParticipants = {
  pageInfo: {
    totalPages: number;
  },
  nodes: {
    player: {
      id: number;
      user: {
        genderPronoun: string | null;
        slug: string | null;
      } | null,
    } | null,
  }[],
}
type User = {
  genderPronoun: string;
  slug: string;
};
async function getEvent(event: { id: number, name: string }, tournament: Tournament, playerIdToUser: Map<number, User>, fh: FileHandle) {
  console.log(`eventId: ${event.id}`);
  const eventEntities = await retryFetch(`https://api.smash.gg/event/${event.id}?expand[]=groups`);
  if (!Array.isArray(eventEntities.groups)) {
    return;
  }
  if (eventEntities.groups.every((group: any) => group.groupTypeId === 3)) {
    console.log('all groups RR');
    return;
  }

  const entrantIdToEntrant = new Map<number, Entrant>();
  const participantIdToEntrantIdAndPlayerId = new Map<number, { entrantId: number, playerId: number}>();
  const sets: any[] = [];
  const groupsSeedsPromises: Promise<any>[] = [];
  const processGroup = async (group: any) => {
    console.log(`groupId: ${group.id}`);
    const groupEntities = await retryFetch(`https://api.smash.gg/phase_group/${group.id}?expand[]=sets&expand[]=seeds`);
    if (!Array.isArray(groupEntities.seeds) || groupEntities.seeds.length === 0) {
      return null;
    }
    if (Array.isArray(groupEntities.sets)) {
      sets.push(...groupEntities.sets);
    }
    return groupEntities.seeds;
  };
  for (const group of eventEntities.groups) {
    if (group.state === 2 || group.state === 3) {
      groupsSeedsPromises.push(processGroup(group));
    }
  }
  const groupsSeeds = (await Promise.all(groupsSeedsPromises)).filter((group: any) => group !== null);
  for (const groupSeeds of groupsSeeds) {
    for (const seed of groupSeeds) {
      const { entrantId, seedNum } = seed;
      if (!entrantId || entrantIdToEntrant.has(entrantId)) {
        continue;
      }

      const entrant = seed.mutations.entrants[entrantId];
      const initialSeedNum = entrant.initialSeedNum;
      const participantIds = entrant.participantIds;
      if (!Array.isArray(participantIds) || participantIds.length === 0) {
        continue;
      }

      const participant = seed.mutations.participants[participantIds[0]];
      if (participant) {
        const player = seed.mutations.players[participant.playerId];
        if (player) {
          const user = playerIdToUser.get(player.id);
          if (user) {
            entrantIdToEntrant.set(entrantId, { id: entrantId, name: participant.gamerTag, pronouns: user.genderPronoun, seed: initialSeedNum || seedNum, slug: user.slug });
          } else {
            entrantIdToEntrant.set(entrantId, { id: entrantId, name: participant.gamerTag, pronouns: '', seed: initialSeedNum || seedNum, slug: '' });
            participantIdToEntrantIdAndPlayerId.set(participant.id, { entrantId, playerId: player.id });
          }
        } else {
          entrantIdToEntrant.set(entrantId, { id: entrantId, name: participant.gamerTag, pronouns: '', seed: initialSeedNum || seedNum, slug: '' });
        }
      }
    }
  }

  if (participantIdToEntrantIdAndPlayerId.size > 0) {
    let participantsPage = 1;
    let nextParticipants: ApiParticipants;
    do {
      console.log(`participants: slug: ${tournament.slug}, eventIds: [${event.id}], page: ${participantsPage}`);
      nextParticipants = (await fetchGql(TOURNAMENT_PARTICIPANTS_QUERY, { slug: tournament.slug, eventIds: [event.id], page: participantsPage })).tournament.participants;
      for (const participant of nextParticipants.nodes) {
        const { player } = participant;
        if (!player) {
          continue;
        }
        const genderPronoun = player.user?.genderPronoun || '';
        const slug = player.user?.slug?.slice(5) || '';
        playerIdToUser.set(player.id, { genderPronoun, slug });
      }
      participantsPage++
    } while (participantsPage <= nextParticipants.pageInfo.totalPages);
    for (const entrantIdAndPlayerId of participantIdToEntrantIdAndPlayerId.values()) {
      const entrant = entrantIdToEntrant.get(entrantIdAndPlayerId.entrantId)!;
      const { id, name, seed } = entrant;
      const user = playerIdToUser.get(entrantIdAndPlayerId.playerId);
      if (user) {
        entrantIdToEntrant.set(id, { id, name, pronouns: user.genderPronoun, seed, slug: user.slug });
      } else {
        entrantIdToEntrant.set(id, { id, name, pronouns: '', seed, slug: '' });
      }
    }
  }

  const sheOrHerIds = new Set<number>();
  for (const entrant of entrantIdToEntrant.values()) {
    if (entrant.pronouns) {
      const lowerCase = entrant.pronouns.toLowerCase();
      const heHim = lowerCase.includes('he') || lowerCase.includes('him');
      if (lowerCase.includes('she') || lowerCase.includes('her') || !heHim) {
        sheOrHerIds.add(entrant.id);
      }
    }
  }

  for (const set of sets) {
    const { entrant1Id, entrant2Id, entrant1Score, entrant2Score, winnerId } = set;
    if (!entrant1Id || !entrant2Id || !winnerId || entrant1Score === -1 || entrant2Score === -1) {
      continue;
    }

    const entrant1 = entrantIdToEntrant.get(entrant1Id)!;
    const entrant2 = entrantIdToEntrant.get(entrant2Id)!;
    const entrant1SeedTier = getSeedTier(entrant1.seed);
    const entrant2SeedTier = getSeedTier(entrant2.seed);
    if (entrant1SeedTier === null || entrant2SeedTier === null || entrant1SeedTier === entrant2SeedTier) {
      continue;
    }

    const lowerEntrant = entrant1SeedTier < entrant2SeedTier ? entrant2 : entrant1;
    if (winnerId === lowerEntrant.id && sheOrHerIds.has(lowerEntrant.id)) {
      const factor = Math.abs(entrant1SeedTier - entrant2SeedTier);
      const opponent = entrant1SeedTier < entrant2SeedTier ? entrant1 : entrant2;
      console.log(`${lowerEntrant.name} (${lowerEntrant.pronouns}), ${lowerEntrant.seed} seed upset ${opponent.name} (${opponent.pronouns}), ${opponent.seed} seed (factor: ${factor}) at ${tournament.name} - ${event.name}`);
      await fh.write(`"${lowerEntrant.slug}","${lowerEntrant.name}","${lowerEntrant.pronouns}",${lowerEntrant.seed},"${opponent.slug}","${opponent.name}","${opponent.pronouns}",${opponent.seed},${factor},"${tournament.name}","${event.name}",${tournament.startAt * 1000}\n`);
    }
  }
}

const TOURNAMENTS_QUERY = `
  query TournamentsQuery($page: Int, $afterDate: Timestamp) {
    tournaments(
      query: {page: $page, perPage: 500, filter: {afterDate: $afterDate, past: true, videogameIds: [1]}, sortBy: "startAt ASC"}
    ) {
      pageInfo {
        totalPages
      }
      nodes {
        slug
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
    slug: string;
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
  const playerIdToUser = new Map<number, User>();
  let afterDate = 1426345200;
  let nextTournaments: ApiTournaments;
  const seenSlugs = new Set<string>();
  while(true) {
    let tournamentPage = 1;
    do {
      console.log(`tournaments page ${tournamentPage}`);
      nextTournaments = (await fetchGql(TOURNAMENTS_QUERY, { page: tournamentPage, afterDate })).tournaments;
      for (const apiTournament of nextTournaments.nodes) {
        const { slug } = apiTournament;
        if (seenSlugs.has(slug)) {
          continue;
        }

        const tournament: Tournament = { slug, name: apiTournament.name, startAt: apiTournament.startAt };
        console.log(`tournament slug: ${tournament.slug}, date: ${new Date(apiTournament.startAt * 1000)}`);
        for (const event of apiTournament.events) {
          await getEvent(event, tournament, playerIdToUser, fh);
        }
      }
      if (tournamentPage === 20) {
        let newLastStartAt = 0;
        for (let i = nextTournaments.nodes.length - 1; i >= 0; i--) {
          if (newLastStartAt === 0) {
            newLastStartAt = nextTournaments.nodes[i].startAt;
            seenSlugs.add(nextTournaments.nodes[i].slug);
          } else if (newLastStartAt === nextTournaments.nodes[i].startAt) {
            seenSlugs.add(nextTournaments.nodes[i].slug);
          } else {
            break;
          }
        }
        afterDate = newLastStartAt;
        console.log(`new afterDate: ${afterDate}`);
      }
      tournamentPage++;
      if (tournamentPage > nextTournaments.pageInfo.totalPages) {
        await fh.close();
        return;
      }
    } while (tournamentPage <= 20);
  }
}

if (key) {
  console.log(key);
  getTournaments();
} else {
  console.log('Set STARTGG_API_KEY="asdf" in .env');
}
