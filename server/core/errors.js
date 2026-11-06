'use strict';

/** A caller-facing input problem: becomes a 400 with this message shown to the user. */
class ValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ValidationError';
    }
}

/**
 * A managed section changed outside the app since it was last written: becomes
 * a 409 listing the sections, so the UI can ask before overwriting them.
 */
class ConflictError extends Error {
    constructor(message, conflicts) {
        super(message);
        this.name = 'ConflictError';
        this.conflicts = conflicts;
    }
}

module.exports = { ValidationError, ConflictError };
