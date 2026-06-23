"""run.py — entry point for the Agape interpreter.

Usage:
    python run.py hello.ag                                  # mock provider (default)
    python run.py hello.ag --provider mock
    python run.py hello.ag --provider anthropic             # needs ANTHROPIC_API_KEY
    python run.py hello.ag --provider anthropic --model claude-opus-4-8

Swapping the provider changes no Agape source — only this one line below.
"""
import os
import sys
import argparse
from agape_parser import parse
from spine import Spine
from agape_interp import Interpreter


def main() -> None:
    ap = argparse.ArgumentParser(description="Agape interpreter")
    ap.add_argument("file", help="path to .ag source file")
    ap.add_argument("--provider", choices=["mock", "anthropic"], default="mock")
    ap.add_argument("--model", default="claude-opus-4-8",
                    help="Anthropic model id (only used with --provider anthropic)")
    args = ap.parse_args()

    with open(args.file) as f:
        source = f.read()

    stmts = parse(source)

    if args.provider == "anthropic":
        if not os.environ.get("ANTHROPIC_API_KEY"):
            sys.exit(
                "ANTHROPIC_API_KEY is not set.\n"
                "  export ANTHROPIC_API_KEY=sk-...   # then re-run\n"
                "(and `pip install anthropic` if you haven't — see requirements.txt)"
            )
        try:
            from agape_provider import AnthropicProvider
        except ImportError:
            sys.exit("The 'anthropic' package is not installed. Run: pip install anthropic")
        provider = AnthropicProvider(model=args.model)
    else:
        from agape_provider import MockProvider
        provider = MockProvider()

    spine = Spine()
    interp = Interpreter(spine, provider)

    print(f"=== Running {args.file} with {args.provider} provider ===\n")

    try:
        interp.run(stmts)
    except Exception as exc:
        print(f"\n[RUNTIME ERROR] {exc}")
        import traceback
        traceback.print_exc()

    print("\n\n=== EVENT SPINE ===")
    print(spine.dump())
    print(f"\n{len(spine.log)} events total.")

    pending = spine.pending()
    if pending:
        print(f"\n[WARN] {len(pending)} pending (Started without Resolved):")
        for ev in pending:
            print(f"  {ev}")


if __name__ == "__main__":
    main()
