from wagmiphotos.common.denylist import Denylist


def test_matches_case_insensitive_whole_word():
    d = Denylist(["pikachu", "nike"])
    assert d.matched("a cute Pikachu on a hill") == "pikachu"
    assert d.matched("NIKE shoes, please") == "nike"


def test_no_false_positive_on_substring():
    # word-boundary matching: 'apple' must not trip on 'pineapple'
    d = Denylist(["apple"])
    assert d.matched("a fresh pineapple") is None
    assert d.matched("an apple on a table") == "apple"


def test_multi_word_term():
    d = Denylist(["mickey mouse", "star wars"])
    assert d.matched("mickey mouse at the park") == "mickey mouse"
    assert d.matched("a star wars poster") == "star wars"


def test_no_match_returns_none():
    assert Denylist(["nike"]).matched("a red cat in a field") is None


def test_empty_denylist_matches_nothing():
    assert Denylist([]).matched("nike pikachu mario") is None


def test_from_spec_parses_comma_separated_and_ignores_blanks():
    d = Denylist.from_spec("  nike , Pikachu ,, ")
    assert d.matched("a pikachu") == "pikachu"
    assert d.matched("got NIKE") == "nike"
    assert d.matched("a dog") is None
