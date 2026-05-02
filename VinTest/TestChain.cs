using System;
using System.Collections;
using System.Collections.Generic;
using System.Runtime.CompilerServices;

namespace VinTest;

/// <summary>
/// Builder for a sequence of <see cref="TestStep"/>s that make up a test method in <see cref="ITestSuite"/>.
/// </summary>
public class TestChain : IEnumerable<TestStep>
{
    private readonly List<TestStep> _steps = [];

    /// <summary>
    /// Executes <paramref name="action"/> synchronously; fails the test on exception.
    /// </summary>
    public TestChain Do(Action action)
    {
        _steps.Add(new TestStep.DoStep(action));
        return this;
    }

    /// <summary>
    /// Delays next steps for <paramref name="ms"/> milliseconds before continuing.
    /// </summary>
    public TestChain Wait(int ms)
    {
        _steps.Add(new TestStep.ConditionalWaitStep(ms, () => true));
        return this;
    }

    /// <summary>
    /// If <paramref name="condition"/> is true at when step executes, delays next steps for
    /// <paramref name="ms"/> milliseconds.
    /// Otherwise, skip the wait and proceed immediately.
    /// </summary>
    public TestChain WaitIf(int ms, Func<bool> condition)
    {
        _steps.Add(new TestStep.ConditionalWaitStep(ms, condition));
        return this;
    }

    /// <summary>
    /// Evaluates <paramref name="condition"/> and records the result under <paramref name="name"/>.
    /// Source location is captured automatically for clickable output on failure.
    /// </summary>
    public TestChain Assert(
        string name,
        Func<bool> condition,
        [CallerFilePath] string file = "",
        [CallerLineNumber] int line = 0
    )
    {
        _steps.Add(new TestStep.AssertStep(name, condition, $"{file}:{line}"));
        return this;
    }

    public IEnumerator<TestStep> GetEnumerator() => _steps.GetEnumerator();

    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
}

public abstract record TestStep
{
    private TestStep() { }

    public sealed record ConditionalWaitStep(int Ms, Func<bool> Condition) : TestStep;

    public sealed record DoStep(Action Action) : TestStep;

    public sealed record AssertStep(string Name, Func<bool> Condition, string Location) : TestStep;
}
