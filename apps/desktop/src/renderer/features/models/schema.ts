export type FormValue = string | number | boolean | null;

export interface Property {
    readonly name: string;
    readonly type: 'string' | 'number' | 'integer' | 'boolean';
    readonly title: string;
    readonly description?: string;
    readonly secret: boolean;
    readonly format?: string;
    readonly options?: readonly string[];
    readonly required: boolean;
}

/**
 * Read the flat JSON Schema subset Whim renders: an object of string, number, integer, boolean,
 * and string-enum properties. Anything else is reported instead of guessed.
 * @param schema The schema.
 * @returns Properties in display order, or an error.
 */
export function readSchema(
    schema: Readonly<Record<string, unknown>>
): { properties: Property[] } | { error: string } {
    if (
        schema.type !== 'object' ||
        typeof schema.properties !== 'object' ||
        schema.properties === null
    )
        return { error: 'Only object schemas can be rendered.' };
    const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
    const properties: (Property & { order: number })[] = [];
    for (const [name, raw] of Object.entries(schema.properties)) {
        if (typeof raw !== 'object' || raw === null)
            return { error: `Property ${name} is not a schema.` };
        const value = raw as Record<string, unknown>;
        const type = value.type ?? (Array.isArray(value.enum) ? 'string' : undefined);
        if (type !== 'string' && type !== 'number' && type !== 'integer' && type !== 'boolean')
            return { error: `Property ${name} has an unsupported type.` };
        properties.push({
            name,
            type,
            title: typeof value.title === 'string' ? value.title : name,
            ...(typeof value.description === 'string' ? { description: value.description } : {}),
            secret: value.writeOnly === true,
            ...(typeof value.format === 'string' ? { format: value.format } : {}),
            ...(Array.isArray(value.enum) ? { options: value.enum.map(String) } : {}),
            required: required.has(name),
            order: typeof value['x-whim-order'] === 'number' ? value['x-whim-order'] : 1000,
        });
    }
    properties.sort((left, right) => left.order - right.order);
    return { properties };
}
