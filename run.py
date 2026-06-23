"""run.py — entry point for the Agape interpreter.

Usage:
    python run.py hello.ag                   # mock provider (default)
    python run.py hello.ag --provider mock
    python run.py hello.ag --provider anthropic   # needs ANTHROPIC_API_KEY
"""
import sys
import argparse
from agape_parser import parse
from spine import Spine
from agape_interp import Interpreter


def main() -> None:
    ap = argparse.ArgumentParser(description="Agape interpreter")
    ap.add_argument("file", help="path to .ag source file")
    ap.add_argument("--provider", choices=["mock", "anthropic"], default="mock")
    args = ap.parse_args()

    with open(args.file) as f:
        source = f.read()

    stmts = parse(source)

    if args.provider == "anthropic":
        from agape_provider import AnthropicProvider
        provider = AnthropicProvider()
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
