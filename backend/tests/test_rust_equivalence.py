import sys, os, random, pytest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'app'))
from rust_bridge import best_subset_py, best_subset_rust

BIN = os.path.join(os.path.dirname(__file__), '..', '..', 'rust-kernel', 'target', 'release', 'slatematch-kernel')

@pytest.mark.skipif(not os.path.exists(BIN), reason="rust kernel binary not built")
def test_equivalence_fixtures_and_random():
    cases = [
        (20000, [{"invoice_id": "INV-3", "gross_cents": 20000, "age_days": 30},
                 {"invoice_id": "INV-1", "gross_cents": 12000, "age_days": 40},
                 {"invoice_id": "INV-2", "gross_cents": 8000, "age_days": 5}]),
        (10000, [{"invoice_id": "A", "gross_cents": 7000, "age_days": 3},
                 {"invoice_id": "B", "gross_cents": 9000, "age_days": 9}]),
        (0, [{"invoice_id": "A", "gross_cents": 100, "age_days": 1}]),
    ]
    rng = random.Random(42)
    for trial in range(200):
        n = rng.randint(1, 12)
        invs = [{"invoice_id": f"I{k}", "gross_cents": rng.randrange(100, 5000, 25),
                 "age_days": rng.randint(0, 90)} for k in range(n)]
        cases.append((rng.randrange(500, 20000, 25), invs))
    for target, invs in cases:
        py = best_subset_py(target, invs)
        rs = best_subset_rust(target, invs, binary=BIN)
        assert rs is not None
        assert rs["selected_sum_cents"] == py["selected_sum_cents"], (target, invs, py, rs)
        assert rs["residual_cents"] == py["residual_cents"]
        assert rs["score_milli"] == py["score_milli"], (target, invs, py, rs)
        assert sorted(rs["selected_ids"]) == sorted(py["selected_ids"])
