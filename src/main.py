"""Run the messaging gateway shipped by upstream Hermes."""

from __future__ import annotations


def main() -> None:
    """Delegate process ownership and transport setup to Hermes."""
    from gateway.run import main as run_upstream_gateway

    run_upstream_gateway()


if __name__ == "__main__":
    main()
