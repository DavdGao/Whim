import { randomBytes, randomUUID } from 'node:crypto';

import { Cron } from 'croner';
import { z } from 'zod';

import { StoreError } from './commands.js';

import type { Command } from './commands.js';
import type { ScheduleRow } from './db/protocol.js';
import type { Store } from './store.js';
import type { JsonSchema, ToolDefinition, ToolOutput } from '../plugin/index.js';

// Schedules (design.md §4.1.1): records in SQLite, one timer for the earliest fire, and each fire
// committed with its delivery in one transaction, so a restart never fires twice.

/** A fire this much later than its time counts as missed and follows the schedule's policy. */
export const lateAfterMs = 60_000;
/** The longest the timer waits before reading the schedules again, so clock changes are seen. */
const maxWaitMs = 60 * 60_000;
/** The shortest interval between two fires of a repeating schedule. */
export const minIntervalMs = 5 * 60_000;
/** The most schedules one conversation may have. */
export const maxSchedules = 20;

/** Input the model or the user gave that cannot become a schedule; its message says why. */
export class ScheduleError extends Error {
    /**
     * Create the error.
     * @param message What is wrong, written for the model.
     */
    constructor(message: string) {
        super(message);
        this.name = 'ScheduleError';
    }
}

/** When a schedule fires. */
export type Timing =
    | { readonly kind: 'at'; readonly at: string }
    | { readonly kind: 'cron'; readonly cron: string; readonly timezone: string };

export interface ScheduleInput {
    readonly name: string;
    readonly message: string;
    readonly timing: Timing;
    readonly missed: 'skip' | 'once';
}

export interface SchedulePatch {
    readonly name?: string;
    readonly message?: string;
    readonly at?: string;
    readonly cron?: string;
    readonly timezone?: string;
    readonly missed?: 'skip' | 'once';
    readonly paused?: boolean;
}

export interface SchedulerOptions {
    /** Start or continue the session's run after a fire was delivered. */
    readonly wake: (sessionId: string) => void;
    /** The user's IANA time zone, the default for cron schedules. */
    readonly timezone: () => string;
    /** Report a failure of the timer loop; the loop goes on. */
    readonly onError: (error: unknown) => void;
    readonly now?: () => Date;
}

/**
 * Check an IANA time zone name.
 * @param timezone The name.
 */
function checkTimezone(timezone: string): void {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
        throw new ScheduleError(
            `Unknown time zone "${timezone}"; give an IANA name such as Asia/Shanghai.`
        );
    }
}

/**
 * The next fire of a cron timing after a moment.
 * @param cron Five cron fields.
 * @param timezone The IANA time zone they are read in.
 * @param after The moment, exclusive.
 * @returns The next fire, or null when there is none.
 */
function cronNext(cron: string, timezone: string, after: Date): Date | null {
    return new Cron(cron, { timezone, paused: true }).nextRun(after);
}

/**
 * Check a cron timing: five fields, a known time zone, and fires at least `minIntervalMs` apart.
 * @param cron The expression.
 * @param timezone The time zone.
 * @param now The current time.
 */
function checkCron(cron: string, timezone: string, now: Date): void {
    if (cron.trim().split(/\s+/).length !== 5)
        throw new ScheduleError(
            'cron takes exactly five fields: minute, hour, day of month, month, day of week.'
        );
    checkTimezone(timezone);
    let runs: Date[];
    try {
        runs = new Cron(cron, { timezone, paused: true }).nextRuns(50, now);
    } catch (error) {
        throw new ScheduleError(
            `Invalid cron expression "${cron}": ${error instanceof Error ? error.message : String(error)}`
        );
    }
    if (runs.length === 0) throw new ScheduleError(`The cron expression "${cron}" never fires.`);
    for (let index = 1; index < runs.length; index++) {
        const gap = (runs[index]?.getTime() ?? 0) - (runs[index - 1]?.getTime() ?? 0);
        if (gap < minIntervalMs)
            throw new ScheduleError(
                `The cron expression "${cron}" fires more often than every ${minIntervalMs / 60_000} minutes, the shortest interval allowed.`
            );
    }
}

/**
 * Read a single-fire time: a future date and time with an explicit offset.
 * @param at The text.
 * @param now The current time.
 * @returns The time in UTC ISO form.
 */
function parseAt(at: string, now: Date): string {
    if (!z.iso.datetime({ offset: true }).safeParse(at).success)
        throw new ScheduleError(
            `"${at}" is not a date and time with a UTC offset, such as 2026-11-12T09:00:00+08:00.`
        );
    const time = new Date(at);
    if (time.getTime() <= now.getTime())
        throw new ScheduleError(`${at} has already passed; give a future time.`);
    return time.toISOString();
}

/**
 * Show a moment in a time zone, as ISO 8601 with its offset.
 * @param iso The moment.
 * @param timezone The IANA time zone.
 * @returns For example 2026-11-12T09:00:00+08:00.
 */
export function localTime(iso: string, timezone: string): string {
    const date = new Date(iso);
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            hourCycle: 'h23',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            timeZoneName: 'longOffset',
        })
            .formatToParts(date)
            .map(part => [part.type, part.value])
    );
    const offset = String(parts.timeZoneName ?? 'GMT').replace('GMT', '') || '+00:00';
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

/**
 * Escape a value for an XML attribute.
 * @param value The raw value.
 * @returns The escaped value.
 */
const attribute = (value: string) =>
    value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

/** Owns the schedules' timer and their changes; the only writer of schedule rows. */
export class Scheduler {
    #timer: NodeJS.Timeout | undefined;
    #ticking: Promise<void> = Promise.resolve();
    #stopped = true;

    /**
     * Create the scheduler; it does nothing until `start`.
     * @param store The store holding the schedules.
     * @param options Wake-up, default time zone, error reporting, and clock.
     */
    constructor(
        private readonly store: Store,
        private readonly options: SchedulerOptions
    ) {}

    /** Start the timer; fires missed while Whim was not running are handled first. */
    start(): void {
        this.#stopped = false;
        this.#arm(0);
    }

    /**
     * Stop the timer and wait for a fire in progress.
     * @returns When no fire is in progress.
     */
    async stop(): Promise<void> {
        this.#stopped = true;
        clearTimeout(this.#timer);
        await this.#ticking;
    }

    /**
     * The current time.
     * @returns Now.
     */
    #now(): Date {
        return this.options.now?.() ?? new Date();
    }

    /**
     * Read the schedules again after a delay.
     * @param delay Milliseconds.
     */
    #arm(delay: number): void {
        clearTimeout(this.#timer);
        if (this.#stopped) return;
        this.#timer = setTimeout(() => {
            this.#ticking = this.#ticking.then(() => this.#tick()).catch(this.options.onError);
        }, delay);
        this.#timer.unref();
    }

    /** Fire every due schedule, then wait for the earliest next fire. */
    async #tick(): Promise<void> {
        let wait = maxWaitMs;
        try {
            const now = this.#now();
            for (const schedule of await this.store.schedules())
                if (schedule.nextFire && Date.parse(schedule.nextFire) <= now.getTime())
                    await this.#fire(schedule, now);
            const later = this.#now().getTime();
            for (const schedule of await this.store.schedules())
                if (schedule.nextFire)
                    wait = Math.min(wait, Math.max(0, Date.parse(schedule.nextFire) - later));
        } finally {
            this.#arm(wait);
        }
    }

    /**
     * Commit one due fire: deliver the message, unless it was missed and the policy skips it,
     * and move the schedule to its next fire after now, so missed fires collapse into one.
     * @param schedule The due schedule.
     * @param now The current time.
     */
    async #fire(schedule: ScheduleRow, now: Date): Promise<void> {
        const due = schedule.nextFire;
        if (!due) return;
        const late = now.getTime() - Date.parse(due) > lateAfterMs;
        const timing = schedule.timing;
        const next =
            timing.kind === 'cron'
                ? (cronNext(timing.cron, timing.timezone, now)?.toISOString() ?? null)
                : null;
        const command: Command | undefined =
            late && schedule.missed === 'skip'
                ? undefined
                : {
                      type: 'send',
                      sessionId: schedule.sessionId,
                      operationId: randomUUID(),
                      deliveryId: randomUUID(),
                      placement: 'next-step',
                      item: {
                          type: 'notice',
                          id: randomUUID(),
                          origin: { type: 'core', service: 'schedules' },
                          observedAt: now.toISOString(),
                          kind: 'schedule-fired',
                          payload: {
                              scheduleId: schedule.id,
                              name: schedule.name,
                              dueAt: due,
                              late,
                          },
                          text: schedule.message,
                      },
                  };
        let committed: boolean;
        try {
            committed = await this.store.fireSchedule(schedule.id, due, next, command);
        } catch (error) {
            // Schedules are deleted with their session; one left behind is removed.
            if (error instanceof StoreError && error.code === 'not-found') {
                await this.store.deleteSchedule(schedule.id);
                return;
            }
            throw error;
        }
        if (committed && command) this.options.wake(schedule.sessionId);
    }

    /**
     * A schedule of a session, or an error naming why it cannot be changed.
     * @param sessionId The session asking.
     * @param scheduleId The schedule.
     * @returns The schedule.
     */
    async #own(sessionId: string, scheduleId: string): Promise<ScheduleRow> {
        const schedule = (await this.store.schedules()).find(item => item.id === scheduleId);
        if (!schedule) throw new ScheduleError(`There is no schedule ${scheduleId}.`);
        if (schedule.sessionId !== sessionId)
            throw new ScheduleError(
                `Schedule ${scheduleId} belongs to another conversation; only the user can change it.`
            );
        return schedule;
    }

    /**
     * The first fire of a timing from now.
     * @param timing The timing.
     * @param now The current time.
     * @returns The fire time in UTC ISO form, or null when there is none.
     */
    #firstFire(timing: Timing, now: Date): string | null {
        return timing.kind === 'at'
            ? timing.at
            : (cronNext(timing.cron, timing.timezone, now)?.toISOString() ?? null);
    }

    /**
     * Create a schedule in a session.
     * @param sessionId The session it delivers to.
     * @param input What and when; `timing.at` may carry any offset.
     * @returns The stored schedule.
     */
    async create(sessionId: string, input: ScheduleInput): Promise<ScheduleRow> {
        const now = this.#now();
        const timing: Timing =
            input.timing.kind === 'at'
                ? { kind: 'at', at: parseAt(input.timing.at, now) }
                : input.timing;
        if (timing.kind === 'cron') checkCron(timing.cron, timing.timezone, now);
        if ((await this.store.schedules(sessionId)).length >= maxSchedules)
            throw new ScheduleError(
                `This conversation already has ${maxSchedules} schedules, the most allowed; delete one first.`
            );
        const schedule: ScheduleRow = {
            id: randomBytes(4).toString('hex'),
            sessionId,
            name: input.name,
            message: input.message,
            timing,
            missed: input.missed,
            paused: false,
            nextFire: this.#firstFire(timing, now),
            lastFire: null,
            createdAt: now.toISOString(),
        };
        await this.store.putSchedule(schedule);
        this.#arm(0);
        return schedule;
    }

    /**
     * Change a schedule of a session; omitted fields stay.
     * @param sessionId The session asking.
     * @param scheduleId The schedule.
     * @param patch The changes.
     * @returns The stored schedule.
     */
    async update(
        sessionId: string,
        scheduleId: string,
        patch: SchedulePatch
    ): Promise<ScheduleRow> {
        const current = await this.#own(sessionId, scheduleId);
        const now = this.#now();
        if (patch.at !== undefined && patch.cron !== undefined)
            throw new ScheduleError('Give either at or cron, not both.');
        let timing: Timing = current.timing;
        if (patch.at !== undefined) timing = { kind: 'at', at: parseAt(patch.at, now) };
        else if (patch.cron !== undefined || patch.timezone !== undefined) {
            const cron = patch.cron ?? (timing.kind === 'cron' ? timing.cron : undefined);
            if (cron === undefined)
                throw new ScheduleError(
                    'A time zone applies only to a cron schedule; give cron too.'
                );
            timing = {
                kind: 'cron',
                cron,
                timezone:
                    patch.timezone ??
                    (timing.kind === 'cron' ? timing.timezone : this.options.timezone()),
            };
            checkCron(timing.cron, timing.timezone, now);
        }
        const paused = patch.paused ?? current.paused;
        const retimed = timing !== current.timing || paused !== current.paused;
        if (retimed && !paused && timing.kind === 'at' && Date.parse(timing.at) <= now.getTime())
            throw new ScheduleError(`Its single fire at ${timing.at} has passed; give a new at.`);
        const schedule: ScheduleRow = {
            ...current,
            ...(patch.name === undefined ? {} : { name: patch.name }),
            ...(patch.message === undefined ? {} : { message: patch.message }),
            ...(patch.missed === undefined ? {} : { missed: patch.missed }),
            timing,
            paused,
            nextFire: paused ? null : retimed ? this.#firstFire(timing, now) : current.nextFire,
        };
        await this.store.putSchedule(schedule);
        this.#arm(0);
        return schedule;
    }

    /**
     * Delete a schedule of a session.
     * @param sessionId The session asking.
     * @param scheduleId The schedule.
     */
    async delete(sessionId: string, scheduleId: string): Promise<void> {
        await this.#own(sessionId, scheduleId);
        await this.store.deleteSchedule(scheduleId);
        this.#arm(0);
    }

    /**
     * Describe a schedule for the model as one element, its message as the body.
     * @param schedule The schedule.
     * @param sessionId The session reading it.
     * @returns The element.
     */
    describe(schedule: ScheduleRow, sessionId: string): string {
        const zone =
            schedule.timing.kind === 'cron' ? schedule.timing.timezone : this.options.timezone();
        const attributes: [string, string][] = [
            ['id', schedule.id],
            ['name', schedule.name],
            ...(schedule.timing.kind === 'at'
                ? [['at', localTime(schedule.timing.at, zone)] as [string, string]]
                : [
                      ['cron', schedule.timing.cron] as [string, string],
                      ['timezone', schedule.timing.timezone] as [string, string],
                  ]),
            ['missed', schedule.missed],
            ['paused', String(schedule.paused)],
            ['next', schedule.nextFire ? localTime(schedule.nextFire, zone) : 'none'],
            ['last', schedule.lastFire ? localTime(schedule.lastFire, zone) : 'never'],
            ['conversation', schedule.sessionId === sessionId ? 'this' : schedule.sessionId],
        ];
        return `<schedule ${attributes.map(([key, value]) => `${key}="${attribute(value)}"`).join(' ')}>\n${schedule.message}\n</schedule>`;
    }

    /**
     * The schedule tools of the main agent.
     * @returns ScheduleCreate, ScheduleList, ScheduleUpdate, and ScheduleDelete.
     */
    tools(): ToolDefinition<unknown>[] {
        const common = {
            concurrencySafe: false,
            needsWorkspace: false,
            access: () => [],
        };
        const run =
            (work: (input: unknown, sessionId: string) => Promise<string>) =>
            async (input: unknown, context: { sessionId: string }): Promise<ToolOutput> => {
                try {
                    return { content: await work(input, context.sessionId) };
                } catch (error) {
                    if (error instanceof ScheduleError)
                        return { content: error.message, isError: true };
                    throw error;
                }
            };
        return [
            {
                name: 'ScheduleCreate',
                description: createDescription,
                inputSchema: createSchema,
                readOnly: false,
                ...common,
                execute: run(async (input, sessionId) => {
                    const value = createInput.parse(input);
                    const timing: Timing =
                        value.at !== undefined
                            ? { kind: 'at', at: value.at }
                            : {
                                  kind: 'cron',
                                  cron: value.cron ?? '',
                                  timezone: value.timezone ?? this.options.timezone(),
                              };
                    const schedule = await this.create(sessionId, {
                        name: value.name,
                        message: value.message,
                        timing,
                        missed: value.missed ?? 'once',
                    });
                    return `Created schedule ${schedule.id}.\n${this.describe(schedule, sessionId)}`;
                }),
            },
            {
                name: 'ScheduleList',
                description: listDescription,
                inputSchema: listSchema,
                readOnly: true,
                ...common,
                concurrencySafe: true,
                execute: run(async (input, sessionId) => {
                    const { scope = 'session' } = listInput.parse(input);
                    const schedules = await this.store.schedules(
                        scope === 'session' ? sessionId : undefined
                    );
                    if (schedules.length === 0)
                        return scope === 'session'
                            ? 'This conversation has no schedules.'
                            : 'There are no schedules.';
                    return schedules.map(item => this.describe(item, sessionId)).join('\n\n');
                }),
            },
            {
                name: 'ScheduleUpdate',
                description: updateDescription,
                inputSchema: updateSchema,
                readOnly: false,
                ...common,
                execute: run(async (input, sessionId) => {
                    const { id, ...patch } = updateInput.parse(input);
                    const schedule = await this.update(sessionId, id, patch);
                    return `Updated schedule ${schedule.id}.\n${this.describe(schedule, sessionId)}`;
                }),
            },
            {
                name: 'ScheduleDelete',
                description: deleteDescription,
                inputSchema: deleteSchema,
                readOnly: false,
                ...common,
                execute: run(async (input, sessionId) => {
                    const { id } = deleteInput.parse(input);
                    await this.delete(sessionId, id);
                    return `Deleted schedule ${id}.`;
                }),
            },
        ];
    }
}

const createInput = z.object({
    name: z.string().min(1).max(80),
    message: z.string().min(1).max(4000),
    at: z.string().optional(),
    cron: z.string().optional(),
    timezone: z.string().optional(),
    missed: z.enum(['skip', 'once']).optional(),
});
const listInput = z.object({ scope: z.enum(['session', 'all']).optional() });
const updateInput = z.object({
    id: z.string().min(1),
    name: z.string().min(1).max(80).optional(),
    message: z.string().min(1).max(4000).optional(),
    at: z.string().optional(),
    cron: z.string().optional(),
    timezone: z.string().optional(),
    missed: z.enum(['skip', 'once']).optional(),
    paused: z.boolean().optional(),
});
const deleteInput = z.object({ id: z.string().min(1) });

const nameProperty = {
    type: 'string',
    minLength: 1,
    maxLength: 80,
    description: "a few words naming the schedule, shown to the user, e.g. 'Morning AI briefing'",
};
const messageProperty = {
    type: 'string',
    minLength: 1,
    maxLength: 4000,
    description:
        'what you are told when it fires. Write it as a complete instruction to yourself: by then this conversation may have been compacted, so do not rely on what is in it now.',
};
const atProperty = {
    type: 'string',
    description:
        'for a single fire: a future date and time with its UTC offset, e.g. 2026-11-12T09:00:00+08:00',
};
const cronProperty = {
    type: 'string',
    description:
        "for a repeating schedule: five cron fields (minute, hour, day of month, month, day of week), e.g. '0 9 * * 1-5' for 9:00 on weekdays; fires at most every 5 minutes",
};
const timezoneProperty = {
    type: 'string',
    description:
        "the IANA time zone cron is read in, e.g. Asia/Shanghai; the user's own if omitted",
};
const missedProperty = {
    type: 'string',
    enum: ['skip', 'once'],
    description:
        'fires missed while Whim was not running or the Mac was asleep: skip drops them; once delivers a single late fire, however many were missed. once if omitted',
};

const createDescription = `Schedule a message to be delivered to this conversation later, once or repeatedly.

When a schedule fires, its message arrives as <system-notification kind="schedule" schedule="<id>" name="<name>" due="<time>" time="<time>">message</system-notification>, and you are woken if you are idle. A late="true" attribute means the fire was missed while Whim was not running and delivered afterwards, so its time-dependent parts may no longer apply.

Use it when the user asks for something to happen at a later time or regularly, such as a daily briefing or a reminder. Do not use it to wait for a background job: the job's finishing already wakes you.

Give exactly one of at (a single fire) and cron (repeating). A single-fire schedule is removed after it fires. A conversation has at most ${maxSchedules} schedules. Returns the schedule with its id and next fire time.`;

const listDescription = `List schedules as <schedule> elements: id, name, timing (at, or cron with its timezone), missed policy, whether paused, next and last fire, and the conversation it delivers to ("this" or another conversation's id), with the message as the element's body. Times are shown with their UTC offset.

You can change only the schedules of this conversation; the user manages the others.`;

const updateDescription = `Change a schedule of this conversation. Fields you omit stay as they are.

- Changing at, cron or timezone recomputes the next fire from now; at turns a repeating schedule into a single fire, cron the reverse.
- paused: true stops its fires until paused: false; fires that fall in the pause are not delivered later.

Returns the schedule as it now is.`;

const deleteDescription =
    'Delete a schedule of this conversation. Messages it has already delivered stay in the conversation.';

const createSchema: JsonSchema = {
    type: 'object',
    properties: {
        name: nameProperty,
        message: messageProperty,
        at: atProperty,
        cron: cronProperty,
        timezone: timezoneProperty,
        missed: missedProperty,
    },
    required: ['name', 'message'],
    oneOf: [{ required: ['at'] }, { required: ['cron'] }],
    additionalProperties: false,
};
const listSchema: JsonSchema = {
    type: 'object',
    properties: {
        scope: {
            type: 'string',
            enum: ['session', 'all'],
            description:
                "session: this conversation's schedules; all: every schedule of the user. session if omitted",
        },
    },
    additionalProperties: false,
};
const idProperty = {
    type: 'string',
    description: "the schedule's id, as ScheduleCreate or ScheduleList gave it",
};
const updateSchema: JsonSchema = {
    type: 'object',
    properties: {
        id: idProperty,
        name: { ...nameProperty, description: 'the new name' },
        message: {
            ...messageProperty,
            description: 'the new message, a complete instruction as for ScheduleCreate',
        },
        at: {
            ...atProperty,
            description: 'makes it a single fire at this future time, with its UTC offset',
        },
        cron: { ...cronProperty, description: 'makes it repeat on these five cron fields' },
        timezone: { ...timezoneProperty, description: 'the new IANA time zone for cron' },
        missed: {
            ...missedProperty,
            description: 'the new policy for missed fires, as for ScheduleCreate',
        },
        paused: { type: 'boolean', description: 'true to pause, false to resume' },
    },
    required: ['id'],
    not: { required: ['at', 'cron'] },
    additionalProperties: false,
};
const deleteSchema: JsonSchema = {
    type: 'object',
    properties: { id: idProperty },
    required: ['id'],
    additionalProperties: false,
};
