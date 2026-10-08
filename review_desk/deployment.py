"""Explicit deployment boundaries, independent of business data."""
import os
import re


def settings():
    path = os.environ.get('REVIEW_BASE_PATH', '').rstrip('/')
    if path and not re.fullmatch(r'(?:/[A-Za-z0-9_-]+)+', path):
        raise ValueError('REVIEW_BASE_PATH must be a plain absolute URL prefix')
    publication = os.environ.get('REVIEW_PUBLICATION_ID', '')
    if publication and not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', publication):
        raise ValueError('invalid REVIEW_PUBLICATION_ID')
    experience = os.environ.get('REVIEW_ENVIRONMENT', '') == 'experience'
    if experience and not publication:
        raise ValueError('experience deployments require a publication identity')
    return {'base_path': path, 'publication_id': publication, 'experience': experience}
