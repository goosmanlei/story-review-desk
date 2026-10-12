"""SQL statement helper for the current production schema."""
import sqlite3

def statements(db, script):
    statement = ''
    for line in script.splitlines(keepends=True):
        statement += line
        if sqlite3.complete_statement(statement):
            db.execute(statement)
            statement = ''
