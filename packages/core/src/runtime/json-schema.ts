import { Ajv2020 } from 'ajv/dist/2020.js';

import type { JsonSchema } from '../plugin/index.js';
import type { ErrorObject, ValidateFunction } from 'ajv/dist/2020.js';

export interface SchemaIssue {
    readonly path: string;
    readonly message: string;
}

/** Keywords Whim adds to JSON Schema; documented in design.md §5.6. */
const extensionKeywords = ['x-whim-order'];

const ajv = new Ajv2020({ allErrors: true, strict: true, useDefaults: false });
for (const keyword of extensionKeywords) ajv.addKeyword({ keyword, schemaType: 'number' });
// `password` is an annotation for secret inputs; any string is valid.
ajv.addFormat('password', true);
ajv.addFormat('uri', value => URL.canParse(value));

/** A compiled plugin-provided schema. */
export class CompiledSchema {
    readonly #validate: ValidateFunction;

    /**
     * Compile a schema; throws when the schema itself is invalid or uses unknown keywords.
     * @param schema The JSON Schema.
     */
    constructor(readonly schema: JsonSchema) {
        const id = typeof schema.$id === 'string' ? schema.$id : undefined;
        const existing = id ? ajv.getSchema(id) : undefined;
        this.#validate = existing ?? ajv.compile(schema);
    }

    /**
     * Validate a value.
     * @param value Untrusted input.
     * @returns Issues; empty when valid.
     */
    issues(value: unknown): SchemaIssue[] {
        if (this.#validate(value)) return [];
        return (this.#validate.errors ?? []).map((error: ErrorObject) => ({
            path: error.instancePath || '/',
            message: error.message ?? error.keyword,
        }));
    }

    /**
     * Names of top-level properties marked `writeOnly`, which Core stores as secrets.
     * @returns Secret property names.
     */
    secretProperties(): string[] {
        const properties = this.schema.properties;
        if (!properties || typeof properties !== 'object') return [];
        return Object.entries(properties)
            .filter(
                ([, value]) =>
                    typeof value === 'object' &&
                    value !== null &&
                    'writeOnly' in value &&
                    value.writeOnly === true
            )
            .map(([key]) => key);
    }
}
