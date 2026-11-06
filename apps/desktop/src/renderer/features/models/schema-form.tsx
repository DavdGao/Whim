import {
    Field,
    FieldDescription,
    FieldError,
    FieldGroup,
    FieldLabel,
} from '@whimkit/ui/components/field';
import { Input } from '@whimkit/ui/components/input';
import { Switch } from '@whimkit/ui/components/switch';
import { ListIcon } from 'lucide-react';

import { ChoiceMenu } from '../../components/choice-menu';
import { useT } from '../../lib/i18n';
import { pluginText } from '../../lib/messages';

import { readSchema } from './schema';

import type { FormValue } from './schema';

import { StatusAlert } from '@/components/status-alert';

export interface SchemaFormProps {
    readonly schemaId: string;
    readonly schema: Readonly<Record<string, unknown>>;
    readonly locales: Readonly<Record<string, Readonly<Record<string, string>>>> | undefined;
    readonly values: Readonly<Record<string, FormValue>>;
    readonly secretsSet: readonly string[];
    readonly issues: Readonly<Record<string, string>>;
    readonly onChange: (name: string, value: FormValue) => void;
}

/**
 * Render a form for a plugin-provided JSON Schema with shadcn fields.
 * @param props Form props.
 * @param props.schemaId
 * @param props.schema
 * @param props.locales
 * @param props.values
 * @param props.secretsSet
 * @param props.issues
 * @param props.onChange
 * @returns The fields.
 */
export function SchemaForm({
    schemaId,
    schema,
    locales,
    values,
    secretsSet,
    issues,
    onChange,
}: SchemaFormProps) {
    const { t, locale } = useT();
    const parsed = readSchema(schema);
    if ('error' in parsed) return <StatusAlert tone="error">{parsed.error}</StatusAlert>;
    return (
        <FieldGroup>
            {parsed.properties.map(property => {
                const id = `field-${property.name}`;
                const label = pluginText(
                    locales,
                    locale,
                    `schema.${schemaId}./${property.name}.title`,
                    property.title
                );
                const description = pluginText(
                    locales,
                    locale,
                    `schema.${schemaId}./${property.name}.description`,
                    property.description ?? ''
                );
                const value = values[property.name];
                const error = issues[`/${property.name}`];
                return (
                    <Field key={property.name} data-invalid={Boolean(error)}>
                        <FieldLabel htmlFor={id}>
                            {label}
                            {property.required && !property.secret ? ' *' : ''}
                        </FieldLabel>
                        {property.type === 'boolean' ? (
                            <Switch
                                id={id}
                                checked={value === true}
                                onCheckedChange={checked => onChange(property.name, checked)}
                            />
                        ) : property.options ? (
                            <ChoiceMenu
                                id={id}
                                value={typeof value === 'string' ? value : undefined}
                                choices={property.options.map(option => ({
                                    value: option,
                                    label: option,
                                }))}
                                icon={<ListIcon />}
                                placeholder={label}
                                className="w-full"
                                onChange={next => onChange(property.name, next)}
                            />
                        ) : (
                            <Input
                                id={id}
                                type={
                                    property.secret
                                        ? 'password'
                                        : property.type === 'string'
                                          ? property.format === 'uri'
                                              ? 'url'
                                              : 'text'
                                          : 'number'
                                }
                                autoComplete="off"
                                value={value === null || value === undefined ? '' : String(value)}
                                placeholder={
                                    property.secret && secretsSet.includes(property.name)
                                        ? t('models.secretSet')
                                        : undefined
                                }
                                aria-invalid={Boolean(error)}
                                onChange={event => {
                                    const text = event.currentTarget.value;
                                    onChange(
                                        property.name,
                                        property.type === 'string'
                                            ? text
                                            : text === ''
                                              ? null
                                              : Number(text)
                                    );
                                }}
                            />
                        )}
                        {description && <FieldDescription>{description}</FieldDescription>}
                        {error && <FieldError>{error}</FieldError>}
                    </Field>
                );
            })}
        </FieldGroup>
    );
}
