import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Scheduler } from './schedules.js';
import { Store } from './store.js';

import type { FrozenChatCard } from '../contracts/card.js';
import type { ToolContext, ToolDefinition } from '../plugin/index.js';

const card: FrozenChatCard = {
    id: 'test/model',
    revision: 1,
    adapter: 'test#chat',
    model: 'model',
    name: 'Model',
    contextWindow: 1000,
    maxOutputTokens: 100,
    input: { 'text/plain': {} },
    output: ['text/plain'],
    nativeTools: [],
    options: {},
};

let dir: string;
let store: Store;
before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'whim-schedules-'));
    store = await Store.open(join(dir, 'whim.db'));
});
// Every test starts with no schedules, so a pass fires only its own.
beforeEach(async () => {
    for (const schedule of await store.schedules()) await store.deleteSchedule(schedule.id);
});
after(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
});

/**
 * Create a session.
 * @returns Its id.
 */
async function createSession(): Promise<string> {
    const sessionId = randomUUID();
    await store.execute({
        type: 'create',
        sessionId,
        operationId: randomUUID(),
        title: 'Chat',
        credentialId: 'cred',
        epoch: {
            epochId: randomUUID(),
            system: 'system',
            card,
            renderer: 2,
            tools: [],
            nativeTools: [],
            providerTools: [],
        },
    });
    return sessionId;
}

/**
 * A scheduler on a settable clock that records the sessions it wakes.
 * @param start The clock's first time.
 * @returns The scheduler, its clock setter, and the woken sessions.
 */
function scheduler(start: string) {
    let now = new Date(start);
    const woken: string[] = [];
    const instance = new Scheduler(store, {
        wake: sessionId => woken.push(sessionId),
        timezone: () => 'Asia/Shanghai',
        onError: error => assert.fail(String(error)),
        now: () => now,
    });
    return {
        scheduler: instance,
        woken,
        setNow: (time: string) => {
            now = new Date(time);
        },
    };
}

/**
 * Start a scheduler, let its first pass run, and stop it.
 * @param instance The scheduler.
 */
async function pass(instance: Scheduler): Promise<void> {
    instance.start();
    await new Promise(resolve => setTimeout(resolve, 30));
    await instance.stop();
}

/**
 * Call a tool as the model would.
 * @param tools The scheduler's tools.
 * @param name The tool.
 * @param sessionId The calling session.
 * @param input The arguments.
 * @returns The output.
 */
async function call(
    tools: ToolDefinition<unknown>[],
    name: string,
    sessionId: string,
    input: unknown
) {
    const tool = tools.find(item => item.name === name);
    assert.ok(tool);
    return tool.execute(input, { sessionId } as ToolContext);
}

/**
 * The schedule notices waiting in a session's inbox.
 * @param sessionId The session.
 * @returns Their payloads and texts.
 */
async function fired(sessionId: string) {
    const view = await store.view(sessionId);
    return [...view.inbox.values()].flatMap(pending =>
        pending.item.type === 'notice' && pending.item.kind === 'schedule-fired'
            ? [{ ...pending.item.payload, text: pending.item.text }]
            : []
    );
}

describe('Scheduler', () => {
    it('refuses timings it cannot keep, with the reason', async () => {
        const sessionId = await createSession();
        const { scheduler: instance } = scheduler('2026-11-11T00:00:00Z');
        const tools = instance.tools();
        const create = (input: Record<string, unknown>) =>
            call(tools, 'ScheduleCreate', sessionId, { name: 'n', message: 'm', ...input });
        assert.deepEqual(await create({ cron: '*/1 * * * *' }), {
            content:
                'The cron expression "*/1 * * * *" fires more often than every 5 minutes, the shortest interval allowed.',
            isError: true,
        });
        assert.deepEqual(await create({ cron: '0 0 9 * * *' }), {
            content:
                'cron takes exactly five fields: minute, hour, day of month, month, day of week.',
            isError: true,
        });
        assert.deepEqual(await create({ cron: '0 9 * * *', timezone: 'Mars/Base' }), {
            content: 'Unknown time zone "Mars/Base"; give an IANA name such as Asia/Shanghai.',
            isError: true,
        });
        assert.deepEqual(await create({ at: '2026-11-10T09:00:00+08:00' }), {
            content: '2026-11-10T09:00:00+08:00 has already passed; give a future time.',
            isError: true,
        });
        assert.deepEqual(await create({ at: '2026-11-12 09:00' }), {
            content:
                '"2026-11-12 09:00" is not a date and time with a UTC offset, such as 2026-11-12T09:00:00+08:00.',
            isError: true,
        });
        assert.deepEqual(await store.schedules(sessionId), []);
    });

    it('fires a due schedule once, across restarts, and moves to its next fire', async () => {
        const sessionId = await createSession();
        const first = scheduler('2026-11-11T00:00:00Z');
        const created = await call(first.scheduler.tools(), 'ScheduleCreate', sessionId, {
            name: 'Briefing',
            message: 'Write the briefing.',
            cron: '0 9 * * *',
        });
        const [schedule] = await store.schedules(sessionId);
        assert.ok(schedule);
        assert.equal(
            created.content,
            `Created schedule ${schedule.id}.\n<schedule id="${schedule.id}" name="Briefing" cron="0 9 * * *" timezone="Asia/Shanghai" missed="once" paused="false" next="2026-11-11T09:00:00+08:00" last="never" conversation="this">\nWrite the briefing.\n</schedule>`
        );

        first.setNow('2026-11-11T01:00:20Z');
        await pass(first.scheduler);
        assert.deepEqual(first.woken, [sessionId]);
        assert.deepEqual(await fired(sessionId), [
            {
                scheduleId: schedule.id,
                name: 'Briefing',
                dueAt: '2026-11-11T01:00:00.000Z',
                late: false,
                text: 'Write the briefing.',
            },
        ]);
        const [moved] = await store.schedules(sessionId);
        assert.equal(moved?.nextFire, '2026-11-12T01:00:00.000Z');
        assert.equal(moved?.lastFire, '2026-11-11T01:00:00.000Z');

        // A restart at the same moment finds nothing due.
        const second = scheduler('2026-11-11T01:00:30Z');
        await pass(second.scheduler);
        assert.deepEqual(second.woken, []);
        assert.equal((await fired(sessionId)).length, 1);
    });

    it('delivers missed fires once, late, or skips them, as each schedule says', async () => {
        const sessionId = await createSession();
        const { scheduler: instance, woken, setNow } = scheduler('2026-11-11T00:00:00Z');
        await instance.create(sessionId, {
            name: 'Once',
            message: 'once',
            timing: { kind: 'cron', cron: '0 9 * * *', timezone: 'Asia/Shanghai' },
            missed: 'once',
        });
        await instance.create(sessionId, {
            name: 'Skip',
            message: 'skip',
            timing: { kind: 'cron', cron: '30 9 * * *', timezone: 'Asia/Shanghai' },
            missed: 'skip',
        });
        // Whim was not running for three days.
        setNow('2026-11-14T03:00:00Z');
        await pass(instance);
        assert.deepEqual(woken, [sessionId]);
        assert.deepEqual(
            (await fired(sessionId)).map(item => [item.name, item.dueAt, item.late]),
            [['Once', '2026-11-11T01:00:00.000Z', true]]
        );
        assert.deepEqual(
            (await store.schedules(sessionId)).map(item => [item.name, item.nextFire]),
            [
                ['Once', '2026-11-15T01:00:00.000Z'],
                ['Skip', '2026-11-15T01:30:00.000Z'],
            ]
        );
    });

    it('removes a single-fire schedule after it fires', async () => {
        const sessionId = await createSession();
        const { scheduler: instance, setNow } = scheduler('2026-11-11T00:00:00Z');
        await call(instance.tools(), 'ScheduleCreate', sessionId, {
            name: 'Reminder',
            message: 'Remind the user.',
            at: '2026-11-11T10:00:00+08:00',
        });
        setNow('2026-11-11T02:00:05Z');
        await pass(instance);
        assert.deepEqual(
            (await fired(sessionId)).map(item => item.dueAt),
            ['2026-11-11T02:00:00.000Z']
        );
        assert.deepEqual(await store.schedules(sessionId), []);
    });

    it("lists every schedule but changes only the calling conversation's", async () => {
        const own = await createSession();
        const other = await createSession();
        const { scheduler: instance } = scheduler('2026-11-11T00:00:00Z');
        const tools = instance.tools();
        const theirs = await instance.create(other, {
            name: 'Theirs',
            message: 'm',
            timing: { kind: 'cron', cron: '0 9 * * *', timezone: 'Asia/Shanghai' },
            missed: 'once',
        });
        assert.deepEqual(await call(tools, 'ScheduleList', own, {}), {
            content: 'This conversation has no schedules.',
        });
        assert.match(
            (await call(tools, 'ScheduleList', own, { scope: 'all' })).content,
            new RegExp(`<schedule id="${theirs.id}" name="Theirs" [^>]* conversation="${other}">`)
        );
        const refusal = {
            content: `Schedule ${theirs.id} belongs to another conversation; only the user can change it.`,
            isError: true,
        };
        assert.deepEqual(
            await call(tools, 'ScheduleUpdate', own, { id: theirs.id, paused: true }),
            refusal
        );
        assert.deepEqual(await call(tools, 'ScheduleDelete', own, { id: theirs.id }), refusal);
        assert.deepEqual(
            await call(tools, 'ScheduleUpdate', other, { id: theirs.id, paused: true }),
            {
                content: `Updated schedule ${theirs.id}.\n<schedule id="${theirs.id}" name="Theirs" cron="0 9 * * *" timezone="Asia/Shanghai" missed="once" paused="true" next="none" last="never" conversation="this">\nm\n</schedule>`,
            }
        );
        assert.deepEqual(await call(tools, 'ScheduleDelete', other, { id: theirs.id }), {
            content: `Deleted schedule ${theirs.id}.`,
        });
        assert.deepEqual(await store.schedules(), []);
    });

    it('deletes the schedules of a deleted conversation', async () => {
        const sessionId = await createSession();
        const { scheduler: instance } = scheduler('2026-11-11T00:00:00Z');
        await instance.create(sessionId, {
            name: 'n',
            message: 'm',
            timing: { kind: 'at', at: '2026-11-12T00:00:00Z' },
            missed: 'once',
        });
        await store.deleteSession(sessionId);
        assert.deepEqual(await store.schedules(sessionId), []);
    });
});
