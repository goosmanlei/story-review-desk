"""Validate current material ownership, candidates and original evidence."""
def verify(store):
    from .production_current_bundle import validate
    validate(store)
    return {'validated': True, 'materials': store.db.execute("SELECT count(*) FROM objects WHERE kind='REQUIREMENT'").fetchone()[0],
            'candidates': store.db.execute('SELECT count(*) FROM production_candidates').fetchone()[0]}
