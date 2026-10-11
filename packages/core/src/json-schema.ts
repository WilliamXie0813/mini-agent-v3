import type { JSONSchema } from "@mini-agent/ai";

export interface ValidationIssue { path: string; message: string }

const KEYWORDS = new Set([
	"type", "enum", "const", "properties", "required",
	"additionalProperties", "items", "minItems", "maxItems",
	"minLength", "maxLength", "pattern", "minimum", "maximum",
	"description", "title", "default",
]);

export function validateJsonSchema(
	value: unknown,
	schema: JSONSchema,
	path = "arguments",
): ValidationIssue[] {
	const issues = unsupportedKeywords(schema, path);
	const enumValues = schema["enum"];
	if (Array.isArray(enumValues) && !enumValues.some((item) => deepEqual(item, value))) {
		issues.push({ path, message: `expected one of ${JSON.stringify(enumValues)}` });
	}
	if ("const" in schema && !deepEqual(schema["const"], value)) {
		issues.push({ path, message: `expected constant ${JSON.stringify(schema["const"])}` });
	}

	const type = schema["type"];
	if (type !== undefined) {
		if (typeof type !== "string") {
			issues.push({ path, message: "schema type must be a string" });
			return issues;
		}
		if (!matchesType(value, type)) {
			const expected = type === "number" && typeof value === "number"
				? "finite number"
				: type;
			issues.push({ path, message: `expected ${expected}, got ${describeType(value)}` });
			return issues;
		}
	}

	if (typeof value === "string") validateString(value, schema, path, issues);
	if (Array.isArray(value)) validateArray(value, schema, path, issues);
	if (isRecord(value)) validateObject(value, schema, path, issues);
	if (typeof value === "number" && Number.isFinite(value))
		validateNumber(value, schema, path, issues);
	return issues;
}

function unsupportedKeywords(schema: JSONSchema, path: string): ValidationIssue[] {
	return Object.keys(schema)
		.filter((keyword) => !KEYWORDS.has(keyword))
		.map((keyword) => ({
			path,
			message: `unsupported schema keyword "${keyword}"`,
		}));
}

function validateString(
	value: string,
	schema: JSONSchema,
	path: string,
	issues: ValidationIssue[],
): void {
	const min = schema["minLength"];
	const max = schema["maxLength"];
	if (typeof min === "number" && value.length < min)
		issues.push({ path, message: `must have length >= ${min}` });
	if (typeof max === "number" && value.length > max)
		issues.push({ path, message: `must have length <= ${max}` });
	const pattern = schema["pattern"];
	if (typeof pattern !== "string") return;
	let regex: RegExp;
	try { regex = new RegExp(pattern); }
	catch {
		issues.push({ path, message: `invalid pattern "${pattern}"` });
		return;
	}
	if (!regex.test(value))
		issues.push({ path, message: `must match pattern "${pattern}"` });
}

function validateArray(
	value: unknown[],
	schema: JSONSchema,
	path: string,
	issues: ValidationIssue[],
): void {
	const min = schema["minItems"];
	const max = schema["maxItems"];
	if (typeof min === "number" && value.length < min)
		issues.push({ path, message: `must contain >= ${min} items` });
	if (typeof max === "number" && value.length > max)
		issues.push({ path, message: `must contain <= ${max} items` });
	const items = schema["items"];
	if (!isRecord(items)) return;
	value.forEach((item, index) => {
		issues.push(...validateJsonSchema(item, items, `${path}[${index}]`));
	});
}

function validateObject(
	value: Record<string, unknown>,
	schema: JSONSchema,
	path: string,
	issues: ValidationIssue[],
): void {
	const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
	const required = Array.isArray(schema["required"])
		? schema["required"].filter((name): name is string => typeof name === "string")
		: [];
	for (const name of required) {
		if (!(name in value)) issues.push({ path: `${path}.${name}`, message: "is required" });
	}
	for (const [name, childSchema] of Object.entries(properties)) {
		if (name in value && isRecord(childSchema))
			issues.push(...validateJsonSchema(value[name], childSchema, `${path}.${name}`));
	}
	const additional = schema["additionalProperties"];
	if (isRecord(additional)) {
		issues.push({ path, message: "schema-valued additionalProperties is not supported" });
		return;
	}
	if (additional === false) {
		for (const name of Object.keys(value)) {
			if (!(name in properties))
				issues.push({ path: `${path}.${name}`, message: "unexpected property" });
		}
	}
}

function validateNumber(
	value: number,
	schema: JSONSchema,
	path: string,
	issues: ValidationIssue[],
): void {
	const minimum = schema["minimum"];
	const maximum = schema["maximum"];
	if (typeof minimum === "number" && value < minimum)
		issues.push({ path, message: `must be >= ${minimum}` });
	if (typeof maximum === "number" && value > maximum)
		issues.push({ path, message: `must be <= ${maximum}` });
}

function matchesType(value: unknown, type: string): boolean {
	const checks: Record<string, () => boolean> = {
		string: () => typeof value === "string",
		number: () => typeof value === "number" && Number.isFinite(value),
		integer: () => typeof value === "number" && Number.isInteger(value),
		boolean: () => typeof value === "boolean",
		object: () => isRecord(value),
		array: () => Array.isArray(value),
		null: () => value === null,
	};
	return checks[type]?.() ?? false;
}

function describeType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) && Array.isArray(right))
		return left.length === right.length &&
			left.every((value, index) => deepEqual(value, right[index]));
	if (!isRecord(left) || !isRecord(right)) return false;
	const leftKeys = Object.keys(left).sort();
	const rightKeys = Object.keys(right).sort();
	return leftKeys.length === rightKeys.length &&
		leftKeys.every((key, index) =>
			key === rightKeys[index] && deepEqual(left[key], right[key]));
}
