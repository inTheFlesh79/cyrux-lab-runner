// Ids end up in file paths and docker arguments, so only plain numbers are accepted.
// Returns the id as a string, or throws.
function parseId(value) {
    const id = String(value);
    if (!/^\d+$/.test(id)) throw new Error('Invalid id');
    return id;
}

module.exports = { parseId };
