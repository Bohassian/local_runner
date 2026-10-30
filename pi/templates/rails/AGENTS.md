<!-- Template from local_runner/pi/templates/rails/. Copy to a Rails
project's root as AGENTS.md, set the versions to match Gemfile.lock and
.ruby-version (sources must be ingested; see list_docs), and add
project-specific notes. -->

# Rails project

This is a Ruby on Rails 7.1 app on Ruby 3.2.

- Docs sources for this project: `rails~7.1` (API reference and Rails Guides)
  and `ruby~3.2` (core and standard library). Pass both as `sources` so
  results match these versions; other Rails/Ruby versions are also indexed.
- Before using a Rails or Ruby method, confirm its name, arguments and
  behavior with `mcp__memory__lookup_symbol` (e.g. `QueryMethods#where`,
  `ActionController::Parameters#permit`, `Hash#dig`). Do not guess APIs, and
  do not use APIs from other Rails versions.
- For how-tos and conventions (migrations, associations, validations,
  callbacks, routing, jobs, mailers), use `mcp__memory__search_docs`; the
  Rails Guides are included.
- Follow the app's existing patterns (look at neighboring models, controllers
  and tests) before introducing new ones.
- Run the test suite (`bin/rails test` or `bundle exec rspec`) after changes
  if it can run offline, and report the result.
