using Microsoft.VisualStudio.TestTools.UnitTesting;

// Stop MSTest from emitting warning MSTEST0001: Explicitly enable or disable tests parallelization
[assembly: Parallelize(
    // Use the number of logical processors on the machine
    Workers = 0,
    // Individual test methods can run in parallel, regardless of their class
    Scope = ExecutionScope.MethodLevel
)]
