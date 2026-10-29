"""Generate the lookup fixtures for Parquet lookups (joins on a key column).

Needs pyarrow, for the list column. Run from the repository root:
  uv run --with pyarrow python packages/providers-parquet/src/fixtures/generate-lookups.py

The values are from data/records.parquet of the Hugging Face dataset
kelkalot/every-ai-policy-ever, data version 1.18, CC-BY-4.0. US-04 is left out
of lookup-records.parquet so that its five definitions have no match.
"""
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

records = [
    ('CA-01', 'Canada', 'Canada', 'North America', ['public-sector use', 'risk-based classification', 'human oversight', 'transparency & labelling', 'evaluation & testing', 'accountability & liability']),
    ('CA-02', 'Canada', 'Canada', 'North America', ['risk-based classification', 'transparency & labelling', 'incident reporting', 'accountability & liability']),
    ('EU-03', 'European Union', 'European Union', 'Europe', ['risk-based classification', 'prohibited practices', 'general-purpose / frontier AI', 'transparency & labelling', 'human oversight', 'incident reporting']),
    ('JP-04', 'Japan', 'Japan', 'East Asia', ['accountability & liability', 'transparency & labelling', 'international cooperation', 'research priorities']),
    ('KR-02', 'South Korea', 'South Korea', 'East Asia', ['risk-based classification', 'general-purpose / frontier AI', 'transparency & labelling', 'deepfakes & synthetic media', 'human oversight', 'safety institute']),
    ('KZ-01', 'Kazakhstan', 'Kazakhstan', 'Central Asia', ['prohibited practices', 'risk-based classification', 'transparency & labelling', 'accountability & liability', 'human oversight', 'deepfakes & synthetic media']),
    ('OECD-01', 'OECD', 'International', 'Global', ['human oversight', 'accountability & liability', 'transparency & labelling', 'international cooperation']),
    ('PE-01', 'Peru', 'Peru', 'Latin America & Caribbean', ['risk-based classification', 'public-sector use', 'accountability & liability']),
    ('TW-01', 'Taiwan', 'Taiwan', 'East Asia', ['risk-based classification', 'transparency & labelling', 'evaluation & testing', 'accountability & liability', 'public-sector use', 'child safety']),
    ('US-CO-01', 'Colorado (US)', 'United States', 'North America', ['risk-based classification', 'accountability & liability', 'transparency & labelling', 'human oversight']),
    ('US-UT-01', 'Utah (US)', 'United States', 'North America', ['transparency & labelling', 'accountability & liability', 'evaluation & testing']),
    ('VN-02', 'Vietnam', 'Vietnam', 'South & Southeast Asia', ['risk-based classification', 'transparency & labelling', 'prohibited practices', 'accountability & liability', 'public-sector use']),
]


def write(name, rows):
    table = pa.table(
        {
            'id': [r[0] for r in rows],
            'jurisdiction': [r[1] for r in rows],
            'country': [r[2] for r in rows],
            'region': [r[3] for r in rows],
            'safety_topics': pa.array([r[4] for r in rows], type=pa.list_(pa.string())),
        }
    )
    pq.write_table(table, Path(__file__).parent / f'{name}.parquet', compression='zstd')


write('lookup-records', records)
by_id = {r[0]: r for r in records}
# KR-02 appears twice with identical values; that is harmless.
write('lookup-duplicate-identical', records + [by_id['KR-02']])
# EU-03 appears twice with different jurisdictions; a join would be ambiguous.
write('lookup-duplicate-conflict', records + [('EU-03', 'EU', 'European Union', 'Europe', by_id['EU-03'][4])])
