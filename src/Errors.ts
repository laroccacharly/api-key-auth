import { Schema } from "effect"

/** A missing, unknown or revoked key; says nothing more, so a caller learns nothing about other keys. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}, { httpApiStatus: 401 }) {}

/** A valid key without the scope the route needs. */
export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", { scope: Schema.String }, { httpApiStatus: 403 }) {}

/** No key with this id. */
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { id: Schema.String }, { httpApiStatus: 404 }) {}

/** A scope the app doesn't accept, asked for at creation. */
export class UnknownScope extends Schema.TaggedError<UnknownScope>()("UnknownScope", { scope: Schema.String }, { httpApiStatus: 400 }) {}
